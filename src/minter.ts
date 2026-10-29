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

const REVERT_STRIKES = 2;

export interface MintContext {
  publicClient: PublicClient;
  cfg: Config;
  state: State;
  nonces: NonceManager;
  budget: GasBudget;
  fees: FeeOracle;
  /** collection -> pattern that last simulated OK; tried first by other wallets. */
  preferred: Map<Address, string>;
  /**
   * collection -> the first wallet's gas estimate for the winning mint pattern. Later wallets
   * reuse it instead of each asking the node again (one round trip saved per wallet).
   */
  gasHints?: Map<Address, { pattern: string; gas: bigint }>;
  /** Balances requested once at the start of the round, in parallel with the safety checks. */
  balances?: Map<Address, Promise<bigint>>;
  /** Called as soon as the mint pattern and gas are chosen (true), or when the wallet gave up before that (false). */
  onPrepared?: (ok: boolean) => void;
  /** Called the moment a transaction has been handed to the node. */
  onSent?: (wallet: Address, atMs: number) => void;
}

export type MintOutcome =
  /** `retry`: transient RPC trouble; worth trying the same wallet again shortly. */
  | { status: "skipped"; reason: string; retry?: boolean }
  | { status: "dry-run"; gas: bigint; cost: string; template: Hex }
  | { status: "minted"; hash: Hex; tokens: number; gasPaid: string; gasPaidWei: bigint }
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
  let signalled = false;
  const prepared = (ok: boolean) => {
    if (!signalled) {
      signalled = true;
      ctx.onPrepared?.(ok);
    }
  };
  try {
    return await mintInner(hot, wallet, ctx, prepared);
  } finally {
    prepared(false); // no-op if the wallet got as far as choosing a mint call
  }
}

async function mintInner(hot: HotMint, wallet: Wallet, ctx: MintContext, prepared: (ok: boolean) => void): Promise<MintOutcome> {
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

  if (cfg.maxBaseFeeWei !== undefined && fees.baseFeePerGas !== undefined && fees.baseFeePerGas > cfg.maxBaseFeeWei) {
    return { status: "skipped", reason: `base fee ${fees.baseFeePerGas} above MAX_BASE_FEE_GWEI; waiting for cheaper gas` };
  }

  // estimateGas doubles as the simulation: it reverts exactly when the call would.
  // With no known-good pattern yet, simulate every candidate and take the cheapest;
  // once one has worked for this collection, other wallets reuse it directly.
  type Choice = { template: MintObservation; data: Hex; gas: bigint };
  let chosen: Choice | undefined;
  let lastErr = "no templates";
  let transient = false;
  const simulate = async (template: MintObservation): Promise<Choice> => {
    const data = retargetCalldata(template.input, template.minter, me);
    const gas = await withTimeout(
      publicClient.estimateGas({ account: me, to: template.target, data, value: 0n }),
      cfg.rpcTimeoutMs,
      "estimateGas",
    );
    return { template, data, gas };
  };
  const note = (e: unknown) => {
    lastErr = errMsg(e);
    // An RPC failure says nothing about the mint; don't let it count as a revert.
    if (!isRevert(e)) transient = true;
  };
  const candidates = ordered(hot, ctx.preferred.get(collection));
  // A wallet that already knows the winning pattern and its gas skips the node entirely.
  const hint = ctx.gasHints?.get(collection);
  const hinted = hint ? candidates.find((c) => patternKey(c) === hint.pattern) : undefined;
  if (hint && hinted) {
    chosen = { template: hinted, data: retargetCalldata(hinted.input, hinted.minter, me), gas: hint.gas };
  } else if (ctx.preferred.has(collection)) {
    for (const t of candidates) {
      try {
        chosen = await simulate(t);
        break;
      } catch (e) {
        note(e);
      }
    }
  } else {
    for (const r of await Promise.allSettled(candidates.map(simulate))) {
      if (r.status === "fulfilled") {
        if (!chosen || r.value.gas < chosen.gas) chosen = r.value;
      } else {
        note(r.reason);
      }
    }
  }
  if (chosen) {
    ctx.preferred.set(collection, patternKey(chosen.template));
    if (!hinted) ctx.gasHints?.set(collection, { pattern: patternKey(chosen.template), gas: chosen.gas });
    prepared(true);
  }
  if (!chosen) {
    return transient
      ? { status: "skipped", reason: `rpc: ${lastErr}`, retry: true }
      : { status: "skipped", reason: `simulation reverted: ${lastErr}` };
  }

  // 25% headroom on the estimate; caps are checked against the worst case.
  const gasLimit = (chosen.gas * 125n) / 100n;
  const cost = gasLimit * fees.maxFeePerGas; // worst case: reserved from the budget, needed in the wallet
  // The per-mint cap is on what the mint is expected to cost (at the current fee), not on the padded
  // worst case, which overstates it by 2.5x and would turn away mints that are within the cap.
  const expected = chosen.gas * ((fees.baseFeePerGas ?? fees.maxFeePerGas) + fees.maxPriorityFeePerGas);
  if (expected > cfg.maxGasCostWei) {
    return { status: "skipped", reason: `expected gas ${formatEther(expected)} ETH is above the per-tx cap` };
  }
  let balance: bigint;
  try {
    balance = await withTimeout(ctx.balances?.get(me) ?? publicClient.getBalance({ address: me }), cfg.rpcTimeoutMs, "getBalance");
  } catch (e) {
    return { status: "skipped", reason: `rpc: ${errMsg(e)}`, retry: true };
  }
  if (balance < cost) {
    return { status: "skipped", reason: `balance ${formatEther(balance)} ETH < worst-case gas ${formatEther(cost)}` };
  }

  if (cfg.dryRun) {
    return { status: "dry-run", gas: chosen.gas, cost: formatEther(cost), template: chosen.template.txHash };
  }

  // Re-check right before spending: another wallet's revert or trap result may have
  // blocked this collection while this wallet was simulating.
  if (state.isBad(collection)) return { status: "skipped", reason: "collection marked bad" };
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

  ctx.onSent?.(me, Date.now());
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
  if (receipt.status !== "success") {
    // A revert that passed simulation still burned gas (sold out, state changed in
    // between). Two strikes and the collection is blocked so later wallets stop paying.
    const strikes = state.recordRevert(collection);
    if (strikes >= REVERT_STRIKES) state.markBad(collection, `reverted on-chain ${strikes} times`);
    return { status: "failed", reason: `reverted on-chain ${hash}` };
  }

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
  return { status: "minted", hash, tokens: holdings.length, gasPaid: formatEther(paid), gasPaidWei: paid };
}
