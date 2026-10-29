import { parseAbi, type Address, type Hex, type PublicClient } from "viem";
import type { State } from "./state.js";
import { errMsg, mapLimit } from "./util.js";
import type { Wallet } from "./wallets.js";

/** A stuck transaction must not hang /collect or /recover forever. */
const RECEIPT_TIMEOUT_MS = 90_000;

const erc721 = parseAbi(["function safeTransferFrom(address from, address to, uint256 tokenId)"]);
const erc1155 = parseAbi([
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
]);

export interface CollectResult {
  planned: number;
  moved: number;
  failed: number;
  lines: string[];
}

/**
 * Moves every NFT recorded in `state` for these wallets into `vault`.
 * With `send: false` it only reports what it would move.
 */
export async function collectNfts(opts: {
  publicClient: PublicClient;
  wallets: Wallet[];
  state: State;
  vault: Address;
  send: boolean;
}): Promise<CollectResult> {
  const { publicClient, wallets, state, vault, send } = opts;
  const res: CollectResult = { planned: 0, moved: 0, failed: 0, lines: [] };
  await mapLimit(wallets, 10, async (w) => {
    const from = w.account.address;
    for (const h of [...state.holdings(from)]) {
      res.planned++;
      const id = BigInt(h.tokenId);
      const desc = `${w.label} ${h.collection} #${h.tokenId}${h.standard === "erc1155" ? ` x${h.amount}` : ""}`;
      if (!send) {
        res.lines.push(`would move ${desc} -> ${vault}`);
        continue;
      }
      try {
        const hash: Hex =
          h.standard === "erc721"
            ? await w.client.writeContract({
                account: w.account, chain: w.client.chain, address: h.collection, abi: erc721,
                functionName: "safeTransferFrom", args: [from, vault, id],
              })
            : await w.client.writeContract({
                account: w.account, chain: w.client.chain, address: h.collection, abi: erc1155,
                functionName: "safeTransferFrom", args: [from, vault, id, BigInt(h.amount), "0x"],
              });
        const r = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
        if (r.status === "success") {
          state.removeHolding(from, h);
          res.moved++;
          res.lines.push(`moved ${desc} ${hash}`);
        } else {
          res.failed++;
          res.lines.push(`REVERTED ${desc} ${hash}`);
        }
      } catch (e) {
        res.failed++;
        res.lines.push(`FAILED ${desc}: ${errMsg(e)}`);
      }
    }
  });
  return res;
}

export interface RecoverResult {
  total: bigint;
  sent: number;
  failed: number;
  lines: string[];
}

/** Sends each wallet's leftover ETH (minus a 2x-margined transfer fee) to `to`. */
export async function recoverEth(opts: {
  publicClient: PublicClient;
  wallets: Wallet[];
  to: Address;
  send: boolean;
}): Promise<RecoverResult> {
  const { publicClient, wallets, to, send } = opts;
  const res: RecoverResult = { total: 0n, sent: 0, failed: 0, lines: [] };
  const fees = await publicClient.estimateFeesPerGas();
  const fee = 21_000n * fees.maxFeePerGas * 2n; // 2x margin so the tx never underfunds
  await mapLimit(wallets, 10, async (w) => {
    const bal = await publicClient.getBalance({ address: w.account.address });
    const value = bal - fee;
    if (value <= 0n) return;
    if (!send) {
      res.total += value;
      res.lines.push(`${w.label} would send ${value} wei to ${to}`);
      return;
    }
    try {
      const hash = await w.client.sendTransaction({
        account: w.account, chain: w.client.chain, to, value, gas: 21_000n,
        maxFeePerGas: fees.maxFeePerGas * 2n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      res.total += value;
      res.sent++;
      res.lines.push(`${w.label} sent ${value} wei ${hash}`);
    } catch (e) {
      res.failed++;
      res.lines.push(`${w.label} FAILED: ${errMsg(e)}`);
    }
  });
  return res;
}
