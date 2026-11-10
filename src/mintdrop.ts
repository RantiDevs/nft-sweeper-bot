import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { DEFAULT_FEE_RECIPIENT, seaDropAbi, SEADROP_ADDRESS } from "./drops.js";
import { DEFAULT_CHAINS } from "./radar.js";
import { mapLimit } from "./util.js";

/**
 * Mints one free public SeaDrop drop on ANY chain from several wallets (what the radar finds, then acts on).
 *
 * Rules, same as the main bot: value is always 0 (so a paid drop is refused), the call is only mintPublic, there is no
 * approval or transfer, each wallet is simulated first, and a wallet that would revert is skipped, not sent.
 * Dry run unless `execute` is true.
 */

export interface MintDropOptions {
  chainId: number;
  nft: Address;
  accounts: PrivateKeyAccount[];
  execute: boolean;
  quantity?: number;
  rpcUrl?: string;
  /** Refuse a wallet whose worst-case gas cost (gas x max fee) is above this many wei of the native coin. */
  maxGasWei?: bigint;
}

export interface WalletResult {
  address: Address;
  status: "would-mint" | "minted" | "skipped" | "failed";
  note: string;
  costWei?: bigint;
  hash?: Hex;
}

const erc721 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export async function mintDrop(o: MintDropOptions): Promise<{ summary: string; results: WalletResult[] }> {
  const spec = DEFAULT_CHAINS.find((c) => c.chainId === o.chainId);
  const url = o.rpcUrl ?? spec?.rpcs[0];
  if (!spec || !url) throw new Error(`no RPC known for chain ${o.chainId}`);
  const chain = defineChain({ id: o.chainId, name: spec.name, nativeCurrency: { name: spec.symbol, symbol: spec.symbol, decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  const pub = createPublicClient({ chain, transport: http(url, { retryCount: 3 }) });
  if ((await pub.getChainId()) !== o.chainId) throw new Error("RPC is on a different chain than requested");

  const drop = await pub.readContract({ address: SEADROP_ADDRESS, abi: seaDropAbi, functionName: "getPublicDrop", args: [o.nft] });
  const now = Math.floor(Date.now() / 1000);
  if (drop.mintPrice !== 0n) throw new Error("this drop is not free; this tool never sends value");
  if (drop.maxTotalMintableByWallet === 0 || Number(drop.endTime) === 0) throw new Error("no public stage is configured for this collection");
  if (now < Number(drop.startTime)) throw new Error(`the public stage opens in ${Math.round((Number(drop.startTime) - now) / 60)} min`);
  if (now >= Number(drop.endTime)) throw new Error("the public stage has ended");

  let recipient: Address | undefined = DEFAULT_FEE_RECIPIENT;
  if (drop.restrictFeeRecipients) {
    recipient = (await pub.readContract({ address: SEADROP_ADDRESS, abi: seaDropAbi, functionName: "getAllowedFeeRecipients", args: [o.nft] }))[0];
    if (!recipient) throw new Error("the drop restricts fee recipients but lists none");
  }
  const quantity = BigInt(Math.max(1, Math.min(o.quantity ?? 1, drop.maxTotalMintableByWallet)));

  const block = await pub.getBlock();
  const tip = await pub.estimateMaxPriorityFeePerGas().catch(() => 0n);
  const maxFee = (block.baseFeePerGas ?? (await pub.getGasPrice())) * 2n + tip;

  const results = await mapLimit(o.accounts, 4, async (acct): Promise<WalletResult> => {
    const address = acct.address;
    try {
      const have = await pub.readContract({ address: o.nft, abi: erc721, functionName: "balanceOf", args: [address] }).catch(() => undefined);
      if (have !== undefined && have >= BigInt(drop.maxTotalMintableByWallet)) return { address, status: "skipped", note: "already holds the per-wallet maximum" };
      const call = { account: address, address: SEADROP_ADDRESS, abi: seaDropAbi, functionName: "mintPublic" as const, args: [o.nft, recipient!, zeroAddress, quantity] as const, value: 0n };
      const gas = await pub.estimateContractGas(call).catch((e: any) => {
        throw new Error(`would revert (${String(e?.shortMessage ?? e?.message ?? e).slice(0, 80)})`);
      });
      const limit = (gas * 13n) / 10n;
      const costWei = limit * maxFee;
      if (o.maxGasWei !== undefined && costWei > o.maxGasWei) return { address, status: "skipped", note: `gas cost ${formatEther(costWei)} ${spec.symbol} is over your cap`, costWei };
      const bal = await pub.getBalance({ address });
      if (bal < costWei) return { address, status: "skipped", note: `balance ${formatEther(bal)} ${spec.symbol} is below the ${formatEther(costWei)} needed`, costWei };
      if (!o.execute) return { address, status: "would-mint", note: `ok, about ${formatEther(gas * maxFee)} ${spec.symbol} of gas`, costWei };

      const wal = createWalletClient({ account: acct, chain, transport: http(url, { retryCount: 3 }) });
      const hash = await wal.writeContract({ ...call, gas: limit, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip });
      const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
      if (rc.status !== "success") return { address, status: "failed", note: "transaction reverted on-chain", hash, costWei: rc.gasUsed * rc.effectiveGasPrice };
      return { address, status: "minted", note: "minted", hash, costWei: rc.gasUsed * rc.effectiveGasPrice };
    } catch (e: any) {
      return { address, status: "failed", note: String(e?.message ?? e).slice(0, 120) };
    }
  });

  const count = (s: WalletResult["status"]) => results.filter((r) => r.status === s).length;
  const spent = results.reduce((a, r) => a + (r.status === "minted" || r.status === "failed" ? (r.costWei ?? 0n) : 0n), 0n);
  const summary = o.execute
    ? `${count("minted")} minted, ${count("failed")} failed, ${count("skipped")} skipped; gas spent ${formatEther(spent)} ${spec.symbol}`
    : `dry run: ${count("would-mint")} wallets could mint, ${count("skipped")} skipped (nothing sent)`;
  return { summary, results };
}
