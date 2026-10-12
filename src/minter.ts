import {
  formatEther,
  type Account,
  type PublicClient,
  type WalletClient,
} from "viem";
import { retargetCalldata } from "./calldata.js";
import type { Config } from "./config.js";
import type { HotMint } from "./detector.js";
import { parseMintLog } from "./logs.js";
import type { State } from "./state.js";

export interface Wallet {
  account: Account;
  client: WalletClient;
}

export type MintOutcome =
  | { status: "skipped"; reason: string }
  | { status: "dry-run"; gas: bigint; cost: bigint }
  | { status: "minted"; hash: string; tokens: number }
  | { status: "failed"; reason: string };

/**
 * Replays the hot mint's template tx from `wallet`: rewrite calldata for our
 * address, simulate, check gas cost against the cap, send, then confirm from
 * the receipt that an NFT actually landed in our wallet.
 */
export async function mintFor(
  hot: HotMint,
  wallet: Wallet,
  publicClient: PublicClient,
  cfg: Config,
  state: State,
): Promise<MintOutcome> {
  const me = wallet.account.address;
  const { collection, template } = hot;

  if (state.mintCount(collection, me) >= cfg.maxMintsPerCollection) {
    return { status: "skipped", reason: "per-collection limit reached" };
  }

  const data = retargetCalldata(template.input, template.minter, me);
  const req = { account: me, to: template.target, data, value: 0n } as const;

  try {
    await publicClient.call(req);
  } catch (e) {
    return { status: "skipped", reason: `simulation reverted: ${short(e)}` };
  }

  let gas: bigint;
  try {
    gas = await publicClient.estimateGas(req);
  } catch (e) {
    return { status: "skipped", reason: `gas estimate failed: ${short(e)}` };
  }
  const fees = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas;
  if (cfg.maxFeePerGasWei !== undefined && maxFeePerGas > cfg.maxFeePerGasWei) {
    return { status: "skipped", reason: `maxFeePerGas ${maxFeePerGas} above cap` };
  }
  // 20% headroom on the estimate; the cap is checked against the worst case.
  const gasLimit = (gas * 12n) / 10n;
  const cost = gasLimit * maxFeePerGas;
  if (cost > cfg.maxGasCostWei) {
    return { status: "skipped", reason: `worst-case gas ${formatEther(cost)} ETH above cap` };
  }

  if (cfg.dryRun) return { status: "dry-run", gas, cost };

  let hash: `0x${string}`;
  try {
    hash = await wallet.client.sendTransaction({
      account: wallet.account,
      chain: wallet.client.chain,
      to: template.target,
      data,
      value: 0n,
      gas: gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
  } catch (e) {
    return { status: "failed", reason: `send failed: ${short(e)}` };
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") return { status: "failed", reason: `reverted ${hash}` };

  const tokens = receipt.logs.filter((l) => {
    const m = parseMintLog(l);
    return m !== null && m.collection === collection && m.to === me;
  }).length;
  if (tokens === 0) {
    // Tx succeeded but nothing minted to us (e.g. the template minted to a
    // fixed recipient). Stop retrying this collection.
    state.markBad(collection);
    return { status: "failed", reason: `no token received in ${hash}; collection marked bad` };
  }
  state.recordMint(collection, me);
  return { status: "minted", hash, tokens };
}

function short(e: unknown): string {
  const msg = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
  return msg.split("\n")[0];
}
