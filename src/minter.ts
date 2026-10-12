import { formatEther, type Address, type Hex, type PublicClient } from "viem";
import type { GasBudget } from "./budget.js";
import { retargetCalldata } from "./calldata.js";
import type { Config } from "./config.js";
import type { Fees, FeeOracle } from "./fees.js";
import { patternKey, type HotMint, type MintObservation } from "./detector.js";
import { parseMintLog } from "./logs.js";
import type { NonceManager } from "./nonce.js";
import type { Holding, State } from "./state.js";
import { errMsg, isRevert, TimeoutError, withTimeout } from "./util.js";
import type { Wallet } from "./wallets.js";

export interface MintContext {
  publicClient: PublicClient;
  cfg: Config;
  state: State;
  nonces: NonceManager;
  budget: GasBudget;
  fees: FeeOracle;
  /** collection -> pattern that last simulated OK; tried first by other wallets. */
  preferred: Map<Address, string>;
}

export type MintOutcome =
  /** `retry`: transient RPC trouble; worth trying the same wallet again shortly. */
  | { status: "skipped"; reason: string; retry?: boolean }
  | { status: "dry-run"; gas: bigint; cost: string; template: Hex }
  | { status: "minted"; hash: Hex; tokens: number; gasPaid: string }
  | { status: "failed"; reason: string };

function ordered(hot: HotMint, preferred?: string): MintObservation[] {
  if (!preferred) return hot.templates;
  const first = hot.templates.filter((t) => patternKey(t) === preferred);
  return [...first, ...hot.templates.filter((t) => patternKey(t) !== preferred)];
}

/**
 * Replays the hot mint from `wallet`: find a template whose retargeted
 * calldata simulates, check gas cost against per-tx, per-wallet-balance and
 * global caps, send with a locally managed nonce, then confirm from the
 * receipt which NFTs actually landed in our wallet.
 */
export async function mintFor(hot: HotMint, wallet: Wallet, ctx: MintContext): Promise<MintOutcome> {
  const { publicClient, cfg, state, nonces, budget } = ctx;
  const me = wallet.account.address;
  const { collection } = hot;

  if (state.isBad(collection)) return { status: "skipped", reason: "collection marked bad" };
  if (state.mintCount(collection, me) >= cfg.maxMintsPerCollection) {
    return { status: "skipped", reason: "per-collection limit reached" };
  }
  let fees: Fees;
  try {
    fees = await withTimeout(ctx.fees.get(), cfg.rpcTimeoutMs, "fees");
  } catch (e) {
    return { status: "skipped", reason: `rpc: ${errMsg(e)}`, retry: true };
  }
  if (cfg.maxFeePerGasWei !== undefined && fees.maxFeePerGas > cfg.maxFeePerGasWei) {
    return { status: "skipped", reason: `maxFeePerGas ${fees.maxFeePerGas} above cap` };
  }

  // estimateGas doubles as the simulation: it reverts exactly when the call would.
  let chosen: { template: MintObservation; data: Hex; gas: bigint } | undefined;
  let lastErr = "no templates";
  let transient = false;
  for (const template of ordered(hot, ctx.preferred.get(collection))) {
    const data = retargetCalldata(template.input, template.minter, me);
    try {
      const gas = await withTimeout(
        publicClient.estimateGas({ account: me, to: template.target, data, value: 0n }),
        cfg.rpcTimeoutMs,
        "estimateGas",
      );
      chosen = { template, data, gas };
      ctx.preferred.set(collection, patternKey(template));
      break;
    } catch (e) {
      lastErr = errMsg(e);
      // An RPC failure says nothing about the mint; don't let it count as a revert.
      if (!isRevert(e)) transient = true;
    }
  }
  if (!chosen) {
    return transient
      ? { status: "skipped", reason: `rpc: ${lastErr}`, retry: true }
      : { status: "skipped", reason: `simulation reverted: ${lastErr}` };
  }

  // 25% headroom on the estimate; caps are checked against the worst case.
  const gasLimit = (chosen.gas * 125n) / 100n;
  const cost = gasLimit * fees.maxFeePerGas;
  if (cost > cfg.maxGasCostWei) {
    return { status: "skipped", reason: `worst-case gas ${formatEther(cost)} ETH above per-tx cap` };
  }
  let balance: bigint;
  try {
    balance = await withTimeout(publicClient.getBalance({ address: me }), cfg.rpcTimeoutMs, "getBalance");
  } catch (e) {
    return { status: "skipped", reason: `rpc: ${errMsg(e)}`, retry: true };
  }
  if (balance < cost) {
    return { status: "skipped", reason: `balance ${formatEther(balance)} ETH < worst-case gas ${formatEther(cost)}` };
  }

  if (cfg.dryRun) {
    return { status: "dry-run", gas: chosen.gas, cost: formatEther(cost), template: chosen.template.txHash };
  }

  if (!budget.tryReserve(cost)) return { status: "skipped", reason: "TOTAL_GAS_BUDGET_ETH exhausted" };

  const { template, data } = chosen;
  const send = (nonce: number, f: Fees) =>
    withTimeout(
      wallet.client.sendTransaction({
        account: wallet.account,
        chain: wallet.client.chain,
        to: template.target,
        data,
        value: 0n,
        gas: gasLimit,
        nonce,
        maxFeePerGas: f.maxFeePerGas,
        maxPriorityFeePerGas: f.maxPriorityFeePerGas,
      }),
      cfg.rpcTimeoutMs,
      "sendTransaction",
    );

  let hash: Hex;
  let nonce = -1;
  const sendWithNonce = (n: number) => ((nonce = n), send(n, fees));
  try {
    try {
      hash = await nonces.use(me, sendWithNonce);
    } catch (e) {
      // A stale local nonce is fixed by the resync the manager already did; retry once.
      if (!/nonce/i.test(errMsg(e))) throw e;
      hash = await nonces.use(me, sendWithNonce);
    }
  } catch (e) {
    budget.release(cost);
    // A send that timed out may still have been broadcast, so it is never retried
    // blindly; any other rejection (RPC hiccup, node refused it) is safe to retry.
    if (e instanceof TimeoutError) {
      nonces.resync(me);
      return { status: "failed", reason: `send timed out: ${errMsg(e)}` };
    }
    const retry = !/insufficient funds/i.test(errMsg(e));
    return retry
      ? { status: "skipped", reason: `send rejected: ${errMsg(e)}`, retry }
      : { status: "failed", reason: `send failed: ${errMsg(e)}` };
  }

  const wait = (h: Hex) => publicClient.waitForTransactionReceipt({ hash: h, timeout: cfg.receiptTimeoutMs });
  let receipt;
  let reserved = cost;
  try {
    receipt = await wait(hash);
  } catch (e) {
    // Stuck (usually fee fell below a spiking base fee). Replace it: same nonce,
    // higher fee, as long as the new worst case still fits the per-tx cap.
    let replaced = false;
    try {
      const bumped = await ctx.fees.bump(fees);
      const bumpedCost = gasLimit * bumped.maxFeePerGas;
      if (bumpedCost <= cfg.maxGasCostWei && budget.tryReserve(bumpedCost - cost)) {
        reserved = bumpedCost;
        hash = await send(nonce, bumped);
        replaced = true;
        receipt = await wait(hash);
      }
    } catch (e2) {
      // "nonce too low" here means the original landed after all.
      if (/nonce/i.test(errMsg(e2))) {
        receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => undefined);
      }
    }
    if (!receipt) {
      // Keep the reservation: the tx may still land and spend gas.
      nonces.resync(me);
      return { status: "failed", reason: `no receipt for ${hash}${replaced ? " (after fee bump)" : ""}: ${errMsg(e)}` };
    }
  }

  const paid = receipt.gasUsed * receipt.effectiveGasPrice;
  budget.release(reserved);
  state.addGasSpent(paid);
  if (receipt.status !== "success") return { status: "failed", reason: `reverted on-chain ${hash}` };

  const holdings: Holding[] = [];
  for (const l of receipt.logs) {
    const m = parseMintLog(l);
    if (!m || m.collection !== collection || m.to !== me) continue;
    for (const t of m.tokens) {
      holdings.push({ collection, standard: m.standard, tokenId: t.id.toString(), amount: t.amount.toString(), tx: hash });
    }
  }
  if (holdings.length === 0) {
    // Tx succeeded but nothing minted to us (e.g. the template minted to a
    // fixed recipient). Stop spending gas on this collection.
    state.markBad(collection, `replayed mint ${hash} delivered no token to us`);
    return { status: "failed", reason: `no token received in ${hash}; collection marked bad` };
  }
  state.recordMint(collection, me, holdings);
  return { status: "minted", hash, tokens: holdings.length, gasPaid: formatEther(paid) };
}
