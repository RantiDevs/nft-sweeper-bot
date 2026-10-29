import { type Address, type Hex, type PublicClient } from "viem";
import { retargetCalldata, selectorOf } from "./calldata.js";
import type { HotMint } from "./detector.js";
import { parseMintLog } from "./logs.js";

/**
 * Safety screening for "mint everything new" mode.
 *
 * No automated check can prove a collection is legitimate. These filters remove
 * the common scam shapes and, together with the wallet rules (wallets hold only
 * gas ETH, the bot never approves anything and never sends ETH with a mint),
 * keep the downside of a bad contract to the gas of one transaction.
 */

/** Selectors a mint has no business calling. If a traced mint calls one, skip the collection. */
const SUSPICIOUS_CALLS = new Set<string>([
  "0x095ea7b3", // approve
  "0xa22cb465", // setApprovalForAll
  "0x39509351", // increaseAllowance
  "0xa9059cbb", // transfer
  "0x23b872dd", // transferFrom
  "0x42842e0e", // safeTransferFrom (721)
  "0xb88d4fde", // safeTransferFrom (721, data)
  "0xf242432a", // safeTransferFrom (1155)
  "0x2eb2c2d6", // safeBatchTransferFrom (1155)
  "0xd505accf", // permit
  "0x2b67b570", // Permit2 permit
]);

export interface TraceFrame {
  type?: string;
  from?: string;
  to?: string;
  value?: string;
  input?: string;
  error?: string;
  calls?: TraceFrame[];
}

/** Returns why a callTracer trace of the mint looks unsafe, or undefined if it looks fine. */
export function screenTrace(frame: TraceFrame): string | undefined {
  const type = (frame.type ?? "").toUpperCase();
  if (type === "SELFDESTRUCT") return "mint self-destructs";
  if (frame.value && BigInt(frame.value) > 0n) return "mint moves ETH";
  // The frame's own selector is not judged (the top frame is the mint itself, already screened
  // by BLOCKED_SELECTORS); every call it makes underneath is.
  for (const c of frame.calls ?? []) {
    const ct = (c.type ?? "").toUpperCase();
    const cin = (c.input ?? "0x") as Hex;
    if (ct === "SELFDESTRUCT") return "mint self-destructs";
    if (c.value && BigInt(c.value) > 0n) return "mint moves ETH";
    if (ct !== "STATICCALL" && cin.length >= 10 && SUSPICIOUS_CALLS.has(selectorOf(cin))) {
      return `mint calls ${selectorOf(cin)} (approval/transfer) on ${c.to}`;
    }
    const deeper = screenTrace({ ...c, input: "0x" });
    if (deeper) return deeper;
  }
  return undefined;
}

type SimResult = { reason?: string; verified: boolean; status?: ProbeStatus };

/** What a free simulation of the mint says right now. */
export type ProbeStatus = "delivers" | "reverts" | "no-delivery" | "unsupported";

export type VetResult =
  | { ok: true; /** The free simulation proved a token lands in the minting wallet. */ deliveryVerified?: boolean }
  /** `retryable`: might pass later (e.g. source not verified yet), so don't blocklist it. */
  | { ok: false; reason: string; retryable: boolean };

export interface VetOptions {
  /** Blockscout-compatible base URL, e.g. https://robinhoodchain.blockscout.com */
  explorerApi?: string;
  requireVerified: boolean;
  trace: boolean;
  /** Simulate the mint (eth_simulateV1) and require that the NFT lands in the minting wallet. */
  simulate?: boolean;
  fetchFn?: typeof fetch;
}

const NEG_TTL_MS = 2 * 60_000;

export class Vetter {
  private verified = new Map<Address, { ok: boolean; at: number }>();
  private code = new Map<Address, boolean>();
  private traced = new Map<string, string | undefined>();
  private traceUnsupported = false;
  private simUnsupported = false;
  private delivered = new Map<string, Promise<SimResult>>();
  private traceCache = new Map<string, Promise<string | undefined>>();

  constructor(private client: PublicClient, private opts: VetOptions) {}

  private async hasCode(a: Address): Promise<boolean> {
    const cached = this.code.get(a);
    if (cached !== undefined) return cached;
    const bytecode = await this.client.getCode({ address: a });
    const ok = !!bytecode && bytecode !== "0x";
    if (ok) this.code.set(a, true);
    return ok;
  }

  /** True/false from the explorer, or undefined when it can't be reached (never treated as "verified"). */
  async isVerified(a: Address): Promise<boolean | undefined> {
    const hit = this.verified.get(a);
    if (hit && (hit.ok || Date.now() - hit.at < NEG_TTL_MS)) return hit.ok;
    if (!this.opts.explorerApi) return undefined;
    try {
      const res = await (this.opts.fetchFn ?? fetch)(`${this.opts.explorerApi}/api/v2/smart-contracts/${a}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 404) {
        this.verified.set(a, { ok: false, at: Date.now() });
        return false;
      }
      if (!res.ok) return undefined;
      const body = (await res.json()) as { is_verified?: boolean; is_fully_verified?: boolean };
      const ok = body.is_verified === true || body.is_fully_verified === true;
      this.verified.set(a, { ok, at: Date.now() });
      return ok;
    } catch {
      return undefined;
    }
  }

  private async traceMint(from: Address, to: Address, data: Hex): Promise<string | undefined> {
    if (this.traceUnsupported) return undefined;
    try {
      const frame = (await this.client.request({
        method: "debug_traceCall" as never,
        params: [{ from, to, data, value: "0x0" }, "latest", { tracer: "callTracer" }] as never,
      })) as TraceFrame;
      return screenTrace(frame);
    } catch (e) {
      // Most public RPCs don't expose the debug namespace; fall back to the other checks.
      if (/not found|not supported|unsupported|disabled|not available|method/i.test(String((e as Error).message))) {
        this.traceUnsupported = true;
      }
      return undefined;
    }
  }

  /**
   * Runs the mint against current state without sending it and checks that a token is
   * minted to `from`. A trap that mints to someone else is caught here for free, instead
   * of costing one real transaction. Returns a reason when it would NOT deliver, undefined
   * when it would (or when the RPC can't simulate, so the scout wallet check still applies).
   */
  private async simulateDelivery(from: Address, collection: Address, to: Address, data: Hex): Promise<SimResult> {
    if (this.simUnsupported) return { verified: false, status: "unsupported" };
    try {
      const res = (await this.client.request({
        method: "eth_simulateV1" as never,
        params: [
          { blockStateCalls: [{ calls: [{ from, to, data, value: "0x0" }] }], validation: false },
          "latest",
        ] as never,
      })) as { calls?: { status?: string; logs?: { address: Address; topics: Hex[]; data: Hex }[] }[] }[];
      const call = res?.[0]?.calls?.[0];
      if (!call) return { verified: false, status: "unsupported" };
      if (call.status === "0x0") return { verified: false, status: "reverts" }; // reverts are reported by gas estimation
      const gotIt = (call.logs ?? []).some((l) => {
        const m = parseMintLog({ address: l.address, topics: l.topics, data: l.data });
        return m !== null && m.collection.toLowerCase() === collection.toLowerCase() && m.to.toLowerCase() === from.toLowerCase();
      });
      return gotIt
        ? { verified: true, status: "delivers" }
        : { verified: false, status: "no-delivery", reason: "simulated mint would not deliver the NFT to your wallet" };
    } catch (e) {
      if (/not found|not supported|unsupported|disabled|not available|method|does not exist/i.test(String((e as Error).message))) {
        this.simUnsupported = true;
      }
      return { verified: false, status: "unsupported" };
    }
  }

  /**
   * Free, uncached check used while waiting for a drop: would this mint succeed right now and
   * put a token in `from`? "reverts" means not open (yet) or not allowed; "unsupported" means
   * the RPC cannot simulate, so the caller must use a plain eth_call instead.
   */
  async probe(from: Address, collection: Address, to: Address, data: Hex): Promise<ProbeStatus> {
    return (await this.simulateDelivery(from, collection, to, data)).status ?? "unsupported";
  }

  /**
   * Vets the hot-mint candidate before any gas is spent: target and collection must be
   * real contracts, source must be verified when required, and (if the node supports
   * tracing) the mint call must not touch approvals, transfers or ETH.
   */
  async check(hot: HotMint, probeFrom: Address, o: { requireVerified?: boolean; trace?: boolean; simulate?: boolean } = {}): Promise<VetResult> {
    const requireVerified = o.requireVerified ?? this.opts.requireVerified;
    const wantTrace = o.trace ?? this.opts.trace;
    const wantSim = o.simulate ?? this.opts.simulate ?? true;
    const t = hot.templates[0];
    const key = `${t.target}:${t.input.slice(0, 10)}`;
    const data = retargetCalldata(t.input, t.minter, probeFrom);

    // Every check starts at once: the time spent is the slowest one, not the sum of all of them.
    const cachedTrace = () => {
      let p = this.traceCache.get(key);
      if (!p) this.traceCache.set(key, (p = this.traceMint(probeFrom, t.target, data)));
      return p;
    };
    const cachedSim = () => {
      let p = this.delivered.get(key);
      if (!p) this.delivered.set(key, (p = this.simulateDelivery(probeFrom, hot.collection, t.target, data)));
      return p;
    };
    const [collectionCode, targetCode, verified, traceBad, sim] = await Promise.all([
      this.hasCode(hot.collection),
      this.hasCode(t.target),
      requireVerified ? this.isVerified(hot.collection) : Promise.resolve(true as boolean | undefined),
      wantTrace ? cachedTrace() : Promise.resolve(undefined),
      wantSim ? cachedSim() : Promise.resolve<SimResult>({ verified: false }),
    ]);

    if (!collectionCode) return { ok: false, reason: "no contract code at collection", retryable: false };
    if (!targetCode) return { ok: false, reason: "mint target is not a contract", retryable: false };
    if (requireVerified) {
      if (verified === undefined) return { ok: false, reason: "could not check source verification (explorer unreachable)", retryable: true };
      if (!verified) return { ok: false, reason: "source code not verified (yet)", retryable: true };
    }
    if (traceBad) return { ok: false, reason: traceBad, retryable: false };
    if (sim.reason) return { ok: false, reason: sim.reason, retryable: false };
    return sim.verified ? { ok: true, deliveryVerified: true } : { ok: true };
  }
}
