import { createPublicClient, createWalletClient, defineChain, getAddress, http, isAddressEqual, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { sleep } from "./util.js";

/**
 * Native-coin bridging through Relay (api.relay.link), from one funder wallet to your own wallets on another chain.
 *
 * Safety rules, all enforced in code BEFORE anything is signed:
 *  - Only the chain's NATIVE coin on both ends. No ERC-20, so no token approvals, ever.
 *  - The transaction must go to Relay's published "depository" for the origin chain (read independently from
 *    GET /chains), on the origin chain, with value exactly equal to the amount, and nothing else in the quote.
 *  - The recipient in the quote must be the address we asked for, which must be one of our own wallets.
 *  - A per-bridge dollar cap, a per-day dollar cap (persisted), and a maximum fee percentage.
 *  - Dry run by default: without `execute: true` it only quotes.
 */

const API = "https://api.relay.link";
const ZERO = "0x0000000000000000000000000000000000000000";

export interface RelayChain {
  id: number;
  name: string;
  httpRpcUrl: string;
  explorerUrl?: string;
  disabled?: boolean;
  depositEnabled?: boolean;
  currency: { symbol: string; decimals: number };
  protocol?: { v2?: { depository?: string } };
}

export interface BridgeRequest {
  fromChainId: number;
  toChainId: number;
  /** Amount of the ORIGIN chain's native coin, in wei. */
  amountWei: bigint;
  sender: Address;
  recipient: Address;
  /** Every address we are allowed to send to (our own wallets). */
  ownWallets: Address[];
  maxUsdPerBridge: number;
  maxUsdPerDay: number;
  maxFeePct: number;
  /** Absolute ceiling on the total fee in dollars (Relay's cut + origin gas). */
  maxFeeUsd: number;
  ledgerFile?: string;
}

export interface BridgePlan {
  requestId: string;
  tx: { to: Address; data: Hex; value: bigint; chainId: number };
  amountUsd: number;
  feeUsd: number;
  feePct: number;
  receiveEstimate: string;
  receiveSymbol: string;
  timeEstimateSec?: number;
}

async function jget(path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Relay ${path} -> HTTP ${res.status}`);
  return res.json();
}

let chainCache: { at: number; chains: RelayChain[] } | undefined;
export async function relayChains(): Promise<RelayChain[]> {
  if (chainCache && Date.now() - chainCache.at < 10 * 60_000) return chainCache.chains;
  const j = await jget("/chains");
  chainCache = { at: Date.now(), chains: j.chains as RelayChain[] };
  return chainCache.chains;
}

function ledgerRead(file: string): { day: string; usd: number } {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const l = JSON.parse(readFileSync(file, "utf8"));
    return l.day === today ? l : { day: today, usd: 0 };
  } catch {
    return { day: today, usd: 0 };
  }
}

/** Gets a quote and refuses anything that does not pass every check. Throws with the reason. */
export async function planBridge(r: BridgeRequest): Promise<BridgePlan> {
  const chains = await relayChains();
  const from = chains.find((c) => c.id === r.fromChainId);
  const to = chains.find((c) => c.id === r.toChainId);
  if (!from || !to) throw new Error(`Relay does not list chain ${!from ? r.fromChainId : r.toChainId}`);
  if (from.disabled || from.depositEnabled === false) throw new Error(`${from.name} deposits are disabled on Relay right now`);
  if (to.disabled) throw new Error(`${to.name} is disabled on Relay right now`);
  const depository = from.protocol?.v2?.depository;
  if (!depository) throw new Error(`Relay publishes no depository address for ${from.name}; refusing to guess`);

  if (!r.ownWallets.some((w) => isAddressEqual(w, r.recipient))) throw new Error("recipient is not one of your own wallets");

  const res = await fetch(`${API}/quote/v2`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user: r.sender,
      recipient: r.recipient,
      originChainId: r.fromChainId,
      originCurrency: ZERO,
      destinationChainId: r.toChainId,
      destinationCurrency: ZERO,
      amount: r.amountWei.toString(),
      tradeType: "EXACT_INPUT",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const q: any = await res.json();
  if (!res.ok || !q.steps) throw new Error(`quote failed: ${String(q?.message ?? res.status).slice(0, 120)}`);

  // Exactly one step, one item, and it is a plain deposit transaction (no approval, no signature request).
  if (q.steps.length !== 1 || q.steps[0].items?.length !== 1 || q.steps[0].kind !== "transaction") throw new Error("quote has extra steps (approval or signature); refusing");
  const item = q.steps[0].items[0];
  const d = item.data;
  if (Number(d.chainId) !== r.fromChainId) throw new Error("transaction is for a different chain than requested");
  if (!isAddressEqual(getAddress(d.to), getAddress(depository))) throw new Error(`transaction goes to ${d.to}, not Relay's published depository ${depository}`);
  if (BigInt(d.value) !== r.amountWei) throw new Error("transaction value differs from the amount requested");
  if (typeof d.data !== "string" || !d.data.startsWith("0x") || d.data.length > 2_000) throw new Error("unexpected transaction data");
  const det = q.details ?? {};
  if (!det.recipient || !isAddressEqual(getAddress(det.recipient), r.recipient)) throw new Error("quote recipient differs from the one requested");
  if (det.currencyIn?.currency?.address !== ZERO || det.currencyOut?.currency?.address !== ZERO) throw new Error("quote is not native-to-native; refusing");

  const amountUsd = Number(det.currencyIn.amountUsd);
  const outUsd = Number(det.currencyOut.amountUsd);
  if (!Number.isFinite(amountUsd) || !Number.isFinite(outUsd) || amountUsd <= 0) throw new Error("quote has no dollar value; refusing");
  // Total cost = what Relay keeps from the amount + the gas we pay on the origin chain.
  const gasUsd = Number(q.fees?.gas?.amountUsd ?? 0);
  const feeUsd = Math.max(0, amountUsd - outUsd) + (Number.isFinite(gasUsd) ? gasUsd : 0);
  const feePct = (feeUsd / amountUsd) * 100;
  if (feeUsd > r.maxFeeUsd) throw new Error(`total fee $${feeUsd.toFixed(3)} is over your limit of $${r.maxFeeUsd}`);
  if (amountUsd > r.maxUsdPerBridge) throw new Error(`$${amountUsd.toFixed(2)} is over the per-bridge cap of $${r.maxUsdPerBridge}`);
  const led = ledgerRead(r.ledgerFile ?? "data/bridge-ledger.json");
  if (led.usd + amountUsd > r.maxUsdPerDay) throw new Error(`would pass today's cap: $${led.usd.toFixed(2)} already sent + $${amountUsd.toFixed(2)} > $${r.maxUsdPerDay}`);
  if (feePct > r.maxFeePct) throw new Error(`fee ${feePct.toFixed(1)}% ($${feeUsd.toFixed(2)}) is over the ${r.maxFeePct}% limit`);

  return {
    requestId: q.requestId ?? item.check?.endpoint?.split("requestId=")[1] ?? "",
    tx: { to: getAddress(d.to), data: d.data as Hex, value: BigInt(d.value), chainId: r.fromChainId },
    amountUsd,
    feeUsd,
    feePct,
    receiveEstimate: det.currencyOut.amountFormatted,
    receiveSymbol: det.currencyOut.currency.symbol,
    timeEstimateSec: det.timeEstimate,
  };
}

/** Signs and sends a plan that planBridge approved, then waits for Relay to report the delivery. */
export async function executeBridge(r: BridgeRequest, plan: BridgePlan, account: PrivateKeyAccount, rpcUrl?: string): Promise<{ hash: Hex; status: string }> {
  const chains = await relayChains();
  const from = chains.find((c) => c.id === r.fromChainId)!;
  const chain = defineChain({
    id: from.id,
    name: from.name,
    nativeCurrency: { name: from.currency.symbol, symbol: from.currency.symbol, decimals: from.currency.decimals },
    rpcUrls: { default: { http: [rpcUrl ?? from.httpRpcUrl] } },
  });
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl ?? from.httpRpcUrl) });
  const pub = createPublicClient({ chain, transport: http(rpcUrl ?? from.httpRpcUrl) });

  const hash = await wallet.sendTransaction({ to: plan.tx.to, data: plan.tx.data, value: plan.tx.value });
  const file = r.ledgerFile ?? "data/bridge-ledger.json";
  const led = ledgerRead(file);
  writeFileSync(file, JSON.stringify({ day: led.day, usd: led.usd + plan.amountUsd }));
  await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });

  let status = "pending";
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    try {
      const s = await jget(`/intents/status/v3?requestId=${plan.requestId}`);
      status = s.status ?? status;
      if (status === "success" || status === "failure" || status === "refunded") break;
    } catch {
      /* keep polling */
    }
  }
  return { hash, status };
}

export const ledgerExists = (f = "data/bridge-ledger.json") => existsSync(f);

/**
 * After a bridge lands in `from`'s address on the destination chain, split the native coin evenly over `recipients`
 * (the other own wallets). Plain transfers: no contracts, no approvals. Keeps a small gas reserve on every wallet.
 */
export async function spreadNative(chainId: number, from: PrivateKeyAccount, recipients: Address[], rpcUrl?: string): Promise<{ to: Address; hash: Hex; wei: bigint }[]> {
  const chains = await relayChains();
  const tc = chains.find((c) => c.id === chainId);
  if (!tc) throw new Error(`Relay does not list chain ${chainId}`);
  const url = rpcUrl ?? tc.httpRpcUrl;
  const chain = defineChain({ id: tc.id, name: tc.name, nativeCurrency: { name: tc.currency.symbol, symbol: tc.currency.symbol, decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  const pub = createPublicClient({ chain, transport: http(url) });
  const wal = createWalletClient({ account: from, chain, transport: http(url) });
  const others = recipients.filter((a) => !isAddressEqual(a, from.address));
  if (others.length === 0) return [];
  const gasPrice = await pub.getGasPrice();
  const reserve = gasPrice * 21_000n * 3n;
  const bal = await pub.getBalance({ address: from.address });
  const each = (bal - reserve * BigInt(others.length + 1)) / BigInt(others.length + 1);
  if (each <= 0n) throw new Error("not enough arrived to split");
  const sent: { to: Address; hash: Hex; wei: bigint }[] = [];
  for (const to of others) {
    const hash = await wal.sendTransaction({ to, value: each, gasPrice });
    await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    sent.push({ to, hash, wei: each });
  }
  return sent;
}
