import { describe, expect, it, vi } from "vitest";
import type { Address, PublicClient } from "viem";
import type { HotMint } from "../src/detector.js";
import { screenTrace, Vetter } from "../src/vet.js";

const C = "0x00000000000000000000000000000000000000c1" as Address;
const hot: HotMint = {
  collection: C, uniqueMinters: 1, mintTxs: 1,
  templates: [{ collection: C, txHash: `0x${"11".repeat(32)}`, blockNumber: 1n, minter: "0x3333333333333333333333333333333333333333", target: C, input: "0x1249c58b", value: 0n }],
};
const ME = "0x2222222222222222222222222222222222222222" as Address;

function client(over: Record<string, unknown> = {}) {
  return {
    getCode: vi.fn(async () => "0x6080"),
    request: vi.fn(async () => ({ type: "CALL", calls: [] })),
    ...over,
  } as unknown as PublicClient;
}

describe("screenTrace", () => {
  it("accepts a plain mint with inner calls to receivers", () => {
    expect(screenTrace({ type: "CALL", calls: [{ type: "CALL", to: "0xabc", input: "0x150b7a02", value: "0x0" }] })).toBeUndefined();
  });

  it("rejects approvals, transfers, ETH movement and self-destruct anywhere in the tree", () => {
    const wrap = (inner: object) => ({ type: "CALL", calls: [{ type: "CALL", calls: [inner] }] });
    expect(screenTrace(wrap({ type: "CALL", to: "0xdead", input: "0xa22cb465" + "0".repeat(128) }))).toMatch(/0xa22cb465/);
    expect(screenTrace(wrap({ type: "CALL", input: "0x095ea7b3" }))).toMatch(/approval/);
    expect(screenTrace(wrap({ type: "CALL", input: "0x23b872dd" }))).toMatch(/transfer/);
    expect(screenTrace(wrap({ type: "CALL", value: "0x1" }))).toMatch(/ETH/);
    expect(screenTrace(wrap({ type: "SELFDESTRUCT" }))).toMatch(/self-destruct/);
  });

  it("ignores read-only calls to those selectors", () => {
    expect(screenTrace({ type: "CALL", calls: [{ type: "STATICCALL", input: "0x23b872dd" }] })).toBeUndefined();
  });
});

describe("Vetter", () => {
  it("rejects collections or mint targets without code, permanently", async () => {
    const v = new Vetter(client({ getCode: vi.fn(async () => "0x") }), { requireVerified: false, trace: false });
    expect(await v.check(hot, ME)).toMatchObject({ ok: false, retryable: false, reason: expect.stringMatching(/no contract code/) });
  });

  it("requires verified source when asked, retrying later instead of blocklisting", async () => {
    let verified = false;
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ is_verified: verified }) })) as unknown as typeof fetch;
    const v = new Vetter(client(), { requireVerified: true, trace: false, explorerApi: "https://scan.example", fetchFn });
    expect(await v.check(hot, ME)).toMatchObject({ ok: false, retryable: true, reason: expect.stringMatching(/not verified/) });
    verified = true;
    // The negative answer is cached briefly; a different Vetter shows the positive path.
    const v2 = new Vetter(client(), { requireVerified: true, trace: false, explorerApi: "https://scan.example", fetchFn });
    expect(await v2.check(hot, ME)).toEqual({ ok: true });
  });

  it("treats an unreachable explorer as 'unknown', never as verified", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const v = new Vetter(client(), { requireVerified: true, trace: false, explorerApi: "https://scan.example", fetchFn });
    expect(await v.check(hot, ME)).toMatchObject({ ok: false, retryable: true });
  });

  it("blocks a mint whose trace shows an approval and caches the verdict", async () => {
    const request = vi.fn(async () => ({ type: "CALL", calls: [{ type: "CALL", to: "0xdead", input: "0xa22cb465" }] }));
    const v = new Vetter(client({ request }), { requireVerified: false, trace: true, simulate: false });
    expect(await v.check(hot, ME)).toMatchObject({ ok: false, retryable: false, reason: expect.stringMatching(/0xa22cb465/) });
    await v.check(hot, ME);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("falls back to the other checks when the RPC has no debug namespace", async () => {
    const request = vi.fn(async () => { throw new Error("the method debug_traceCall does not exist/is not available"); });
    const v = new Vetter(client({ request }), { requireVerified: false, trace: true, simulate: false });
    expect(await v.check(hot, ME)).toEqual({ ok: true });
    await v.check({ ...hot, templates: [{ ...hot.templates[0], input: "0xdeadbeef" }] }, ME);
    expect(request).toHaveBeenCalledTimes(1); // stops asking once known unsupported
  });

  describe("free delivery check (eth_simulateV1)", () => {
    const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const ZERO = `0x${"0".repeat(64)}`;
    const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
    const simResult = (to: string) => [{ calls: [{ status: "0x1", logs: [{ address: C, topics: [TRANSFER, ZERO, pad(to), pad("0x1")], data: "0x" }] }] }];
    const opts = { requireVerified: false, trace: false };

    it("lets a mint through when the simulated call mints a token to the wallet", async () => {
      const request = vi.fn(async () => simResult(ME));
      expect(await new Vetter(client({ request }), opts).check(hot, ME)).toEqual({ ok: true, deliveryVerified: true });
    });

    it("blocks a trap that mints to someone else, before any gas is spent", async () => {
      const request = vi.fn(async () => simResult("0x00000000000000000000000000000000000000ff"));
      expect(await new Vetter(client({ request }), opts).check(hot, ME)).toMatchObject({
        ok: false, retryable: false, reason: expect.stringMatching(/would not deliver/),
      });
    });

    it("blocks a successful call that mints nothing", async () => {
      const request = vi.fn(async () => [{ calls: [{ status: "0x1", logs: [] }] }]);
      expect(await new Vetter(client({ request }), opts).check(hot, ME)).toMatchObject({ ok: false });
    });

    it("leaves reverts to gas estimation, and falls back quietly when unsupported", async () => {
      const reverts = vi.fn(async () => [{ calls: [{ status: "0x0", logs: [] }] }]);
      expect(await new Vetter(client({ request: reverts }), opts).check(hot, ME)).toEqual({ ok: true });
      const unsupported = vi.fn(async () => { throw new Error("the method eth_simulateV1 does not exist/is not available"); });
      const v = new Vetter(client({ request: unsupported }), opts);
      expect(await v.check(hot, ME)).toEqual({ ok: true });
      await v.check({ ...hot, templates: [{ ...hot.templates[0], input: "0xdeadbeef" }] }, ME);
      expect(unsupported).toHaveBeenCalledTimes(1);
    });

    it("can be turned off", async () => {
      const request = vi.fn(async () => simResult("0x00000000000000000000000000000000000000ff"));
      expect(await new Vetter(client({ request }), { ...opts, simulate: false }).check(hot, ME)).toEqual({ ok: true });
      expect(request).not.toHaveBeenCalled();
    });
  });
});
