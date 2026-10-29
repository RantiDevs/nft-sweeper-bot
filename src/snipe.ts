import { formatEther, type Address, type Hex, type PublicClient } from "viem";
import { BLOCKED_SELECTORS, retargetCalldata, selectorOf } from "./calldata.js";
import { parseMintLog } from "./logs.js";
import type { State } from "./state.js";
import { errMsg, sleep } from "./util.js";
import type { Wallet } from "./wallets.js";

/**
 * Snipe mode: for limited, first-come-first-served drops.
 *
 * Everything slow is done BEFORE the mint opens: every wallet's transaction is built and
 * signed in advance (nonce, gas, fees fixed), and connections to the RPC endpoint(s) are
 * warmed. Then the only thing left is to notice the mint is open and send. That check is a
 * free `eth_call`, repeated every few milliseconds without waiting for the previous reply,
 * and the moment one succeeds all signed transactions go out in a single batched request
 * per endpoint. Time from "open" to "sent" is about one network round trip.
 */

export interface SnipeTarget {
  to: Address;
  /** Calldata for every wallet. `{wallet}` is replaced by the wallet's address (32-byte padded). */
  data: Hex;
  /** When the data was copied from someone else's transaction: that sender, swapped for each wallet. */
  copiedFrom?: Address;
  value: bigint;
}

export interface SnipeSettings {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  chainId: number;
  /** Cost caps, checked before anything is armed. */
  maxGasCostWei: bigint;
  totalGasBudgetWei: bigint;
  allowPaid: boolean;
}

export interface Prepared {
  wallet: Wallet;
  data: Hex;
  nonce: number;
  raw: Hex;
}

const pad = (a: Address) => a.toLowerCase().slice(2).padStart(64, "0");

/** The calldata one wallet will send. */
export function calldataFor(target: SnipeTarget, wallet: Address): Hex {
  let data = target.data;
  if (/\{wallet\}/i.test(data)) data = data.replace(/\{wallet\}/gi, pad(wallet)) as Hex;
  if (target.copiedFrom) data = retargetCalldata(data, target.copiedFrom, wallet);
  if (!/^0x([0-9a-f]{2})*$/i.test(data)) throw new Error("calldata is not valid hex after substituting wallet addresses");
  return data.toLowerCase() as Hex;
}

/** Throws if the plan breaks a safety rule; returns the per-wallet worst-case cost. */
export function checkPlan(target: SnipeTarget, s: SnipeSettings, wallets: number): bigint {
  const sel = selectorOf(target.data.replace(/\{wallet\}/gi, "") as Hex);
  if (BLOCKED_SELECTORS.has(sel)) throw new Error(`refusing to send ${sel}: that is an approval/transfer call, not a mint`);
  if (target.value > 0n && !s.allowPaid) {
    throw new Error("this mint sends ETH. Snipe is for free mints; pass --allow-paid if you really mean to pay");
  }
  const perWallet = s.gasLimit * s.maxFeePerGas;
  if (perWallet > s.maxGasCostWei) {
    throw new Error(`worst-case gas per transaction ${formatEther(perWallet)} ETH is above MAX_GAS_COST_ETH (${formatEther(s.maxGasCostWei)})`);
  }
  const total = perWallet * BigInt(wallets);
  if (total > s.totalGasBudgetWei) {
    throw new Error(`worst-case gas for ${wallets} wallets (${formatEther(total)} ETH) is above TOTAL_GAS_BUDGET_ETH (${formatEther(s.totalGasBudgetWei)})`);
  }
  return perWallet;
}

/** Builds and signs one transaction per wallet. Nothing is sent. */
export async function prepare(client: PublicClient, wallets: Wallet[], target: SnipeTarget, s: SnipeSettings): Promise<Prepared[]> {
  checkPlan(target, s, wallets.length);
  const needed = target.value + s.gasLimit * s.maxFeePerGas;
  return Promise.all(
    wallets.map(async (wallet) => {
      const address = wallet.account.address;
      const [nonce, balance] = await Promise.all([
        client.getTransactionCount({ address, blockTag: "pending" }),
        client.getBalance({ address }),
      ]);
      if (balance < needed) throw new Error(`${wallet.label} has ${formatEther(balance)} ETH, needs about ${formatEther(needed)} for the worst case`);
      const data = calldataFor(target, address);
      const raw = await wallet.account.signTransaction({
        type: "eip1559",
        chainId: s.chainId,
        to: target.to,
        data,
        value: target.value,
        gas: s.gasLimit,
        nonce,
        maxFeePerGas: s.maxFeePerGas,
        maxPriorityFeePerGas: s.maxPriorityFeePerGas,
      });
      return { wallet, data, nonce, raw };
    }),
  );
}

export interface FireOptions {
  /** RPC endpoints; the signed transactions go to every one of them at once. */
  urls: string[];
  /** Milliseconds between "is it open?" checks. Checks overlap, none waits for the last. */
  pollMs: number;
  /** Do not send before this time (ms since epoch), even if the check passes. */
  notBefore?: number;
  /** Give up after this long. */
  maxWaitMs: number;
  /** Free check that the mint is open for the first wallet. */
  isOpen: () => Promise<boolean>;
  fetchFn?: typeof fetch;
  onTick?: (checks: number) => void;
}

export interface FireResult {
  opened: boolean;
  openedAt?: number;
  sentAt?: number;
  checks: number;
  /** Hashes reported by the nodes, per wallet label. */
  hashes: Record<string, Hex>;
  errors: string[];
}

/** One batched JSON-RPC request carrying every signed transaction. */
async function broadcast(url: string, raws: Hex[], f: typeof fetch): Promise<{ hash?: Hex; error?: string }[]> {
  const body = JSON.stringify(raws.map((raw, i) => ({ jsonrpc: "2.0", id: i + 1, method: "eth_sendRawTransaction", params: [raw] })));
  const res = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true, signal: AbortSignal.timeout(10_000) });
  const json = (await res.json()) as { id: number; result?: Hex; error?: { message: string } }[] | { error?: { message: string } };
  if (!Array.isArray(json)) return raws.map(() => ({ error: json.error?.message ?? `HTTP ${res.status}` }));
  const byId = new Map(json.map((r) => [r.id, r]));
  return raws.map((_, i) => {
    const r = byId.get(i + 1);
    return r?.result ? { hash: r.result } : { error: r?.error?.message ?? "no reply" };
  });
}

/** Keep connections to every endpoint open so the real send does not pay for a handshake. */
export async function warm(urls: string[], f: typeof fetch = fetch): Promise<void> {
  await Promise.allSettled(
    urls.map((u) =>
      f(u, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', keepalive: true, signal: AbortSignal.timeout(5000) }),
    ),
  );
}

export async function waitAndFire(prepared: Prepared[], o: FireOptions): Promise<FireResult> {
  const f = o.fetchFn ?? fetch;
  const result: FireResult = { opened: false, checks: 0, hashes: {}, errors: [] };
  const deadline = Date.now() + o.maxWaitMs;
  let open = false;
  let inFlight = 0;

  await warm(o.urls, f);
  while (!open && Date.now() < deadline) {
    if ((o.notBefore ?? 0) > Date.now()) {
      // Sleep most of the way, then spin up to the second.
      await sleep(Math.min(o.notBefore! - Date.now(), 1000));
      continue;
    }
    // Overlap the checks: a slow reply must not delay the next question.
    if (inFlight < 8) {
      inFlight++;
      result.checks++;
      o.isOpen().then(
        (ok) => {
          inFlight--;
          if (ok && !open) {
            open = true;
            result.opened = true;
            result.openedAt = Date.now();
            void send();
          }
        },
        () => {
          inFlight--;
        },
      );
    }
    o.onTick?.(result.checks);
    await sleep(o.pollMs);
  }

  async function send(): Promise<void> {
    const raws = prepared.map((p) => p.raw);
    result.sentAt = Date.now();
    const replies = await Promise.allSettled(o.urls.map((u) => broadcast(u, raws, f)));
    replies.forEach((r, endpoint) => {
      if (r.status === "rejected") {
        result.errors.push(`endpoint ${endpoint + 1}: ${errMsg(r.reason)}`);
        return;
      }
      r.value.forEach((x, i) => {
        if (x.hash) result.hashes[prepared[i].wallet.label] = x.hash;
        // The same transaction sent to a second endpoint is expected to be "already known".
        else if (x.error && !/already known|known transaction|nonce too low/i.test(x.error)) result.errors.push(`${prepared[i].wallet.label}: ${x.error}`);
      });
    });
  }

  // Let an in-progress send finish.
  while (open && !Object.keys(result.hashes).length && result.errors.length === 0 && Date.now() < deadline + 15_000) await sleep(20);
  return result;
}

/** After sending: wait for receipts, record minted tokens and gas in `state`. */
export async function settle(
  client: PublicClient,
  prepared: Prepared[],
  hashes: Record<string, Hex>,
  state: State | undefined,
  timeoutMs = 60_000,
): Promise<{ label: string; ok: boolean; tokens: number; gasWei: bigint; note?: string }[]> {
  return Promise.all(
    prepared.map(async (p) => {
      const hash = hashes[p.wallet.label];
      if (!hash) return { label: p.wallet.label, ok: false, tokens: 0, gasWei: 0n, note: "not sent" };
      try {
        const r = await client.waitForTransactionReceipt({ hash, timeout: timeoutMs });
        const gasWei = r.gasUsed * r.effectiveGasPrice;
        state?.addGasSpent(gasWei);
        if (r.status !== "success") return { label: p.wallet.label, ok: false, tokens: 0, gasWei, note: "reverted (sold out or not open for this wallet)" };
        const me = p.wallet.account.address.toLowerCase();
        const minted = r.logs.map((l) => parseMintLog(l)).filter((m) => m !== null && m.to.toLowerCase() === me);
        if (state) {
          for (const m of minted) {
            state.recordMint(m!.collection, p.wallet.account.address, m!.tokens.map((t) => ({ collection: m!.collection, standard: m!.standard, tokenId: t.id.toString(), amount: t.amount.toString(), tx: hash })));
          }
        }
        return { label: p.wallet.label, ok: minted.length > 0, tokens: minted.reduce((a, m) => a + m!.tokens.length, 0), gasWei, note: minted.length ? undefined : "succeeded but minted nothing to this wallet" };
      } catch (e) {
        return { label: p.wallet.label, ok: false, tokens: 0, gasWei: 0n, note: errMsg(e) };
      }
    }),
  );
}
