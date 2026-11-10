import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, getAddress, type Address } from "viem";
import { decodeThirdweb, decodeSeaDrop, isOpenSoon, type RadarDrop } from "../src/radar.js";
import { enrich } from "../src/radar-enrich.js";
import { planBridge } from "../src/bridge.js";
import { PUBLIC_DROP_UPDATED } from "../src/drops.js";

const NFT = getAddress("0x168dd252b47ff4a63dfa98b2f0b573df4df3f3ed");
const ZERO_ROOT = ("0x" + "00".repeat(32)) as `0x${string}`;
const now = 1_800_000_000;

const twData = (conds: { start: number; max?: bigint; limit?: bigint; root?: `0x${string}`; price?: bigint }[]) =>
  encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { name: "a", type: "uint256" }, { name: "b", type: "uint256" }, { name: "c", type: "uint256" }, { name: "d", type: "uint256" },
          { name: "e", type: "bytes32" }, { name: "f", type: "uint256" }, { name: "g", type: "address" }, { name: "h", type: "string" },
        ],
      },
      { type: "bool" },
    ],
    [conds.map((c) => ({ a: BigInt(c.start), b: c.max ?? 1000n, c: 0n, d: c.limit ?? 1n, e: c.root ?? ZERO_ROOT, f: c.price ?? 0n, g: "0x0000000000000000000000000000000000000000" as Address, h: "" })), false],
  );

describe("thirdweb announcements", () => {
  it("a free public condition is mintable once it starts, and ends when the next one begins", () => {
    const drops = decodeThirdweb({ address: NFT, data: twData([{ start: now + 600 }, { start: now + 7200, price: 5n }]), blockNumber: 1n });
    expect(drops).toHaveLength(2);
    expect(drops[0].priceWei).toBe(0n);
    expect(drops[0].endTime).toBe(now + 7200);
    expect(isOpenSoon(drops[0], now, 3 * 3600)).toBe(true);
    expect(isOpenSoon(drops[1], now, 3 * 3600)).toBe(false); // paid
  });

  it("an allowlist condition (merkle root set) is never treated as free", () => {
    const [d] = decodeThirdweb({ address: NFT, data: twData([{ start: now - 10, root: ("0x" + "11".repeat(32)) as `0x${string}` }]), blockNumber: 1n });
    expect(isOpenSoon(d, now, 3600)).toBe(false);
  });

  it("garbage data decodes to nothing instead of throwing", () => {
    expect(decodeThirdweb({ address: NFT, data: "0x1234", blockNumber: 1n })).toEqual([]);
  });
});

describe("window rules", () => {
  const base: RadarDrop = { platform: "seadrop", nft: NFT, mintTo: NFT, priceWei: 0n, startTime: now + 3000, endTime: now + 9000, maxPerWallet: 1, block: 1n };
  it("accepts free drops inside the window, rejects paid, ended, later and zero-limit ones", () => {
    expect(isOpenSoon(base, now, 3 * 3600)).toBe(true);
    expect(isOpenSoon({ ...base, priceWei: 1n }, now, 3 * 3600)).toBe(false);
    expect(isOpenSoon({ ...base, startTime: now - 9000, endTime: now - 1 }, now, 3 * 3600)).toBe(false);
    expect(isOpenSoon({ ...base, startTime: now + 5 * 3600, endTime: now + 6 * 3600 }, now, 3 * 3600)).toBe(false);
    expect(isOpenSoon({ ...base, maxPerWallet: 0 }, now, 3 * 3600)).toBe(false);
  });
  it("rejects a malformed SeaDrop log", () => {
    expect(decodeSeaDrop({ address: NFT, topics: [PUBLIC_DROP_UPDATED], data: "0x", blockNumber: 1n })).toBeNull();
  });
});

describe("enrich: the Enter Elysium lesson", () => {
  const hit = (over: Partial<RadarDrop> = {}) => ({
    chain: "Elysium", chainId: 99901, symbol: "HYPE", state: "LIVE" as const, opensInSec: -60,
    drop: { platform: "seadrop" as const, nft: NFT, mintTo: NFT, priceWei: 0n, startTime: now - 60, endTime: now + 86400, maxPerWallet: 1, block: 1n, ...over },
  });
  const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
  const rpcWith = (minted: bigint, max: bigint, mintOk: boolean) => async (method: string, params: any[]) => {
    if (method !== "eth_call") throw new Error("unexpected " + method);
    const data: string = params[0].data;
    if (data.startsWith("0x18160ddd")) return word(minted);
    if (data.startsWith("0xd5abeb01")) return word(max);
    if (mintOk) return "0x";
    throw Object.assign(new Error("execution reverted"), { rpc: true });
  };

  it("flags a collection that is sold out on-chain, whatever OpenSea says", async () => {
    const r = await enrich(hit(), rpcWith(8888n, 8888n, false), undefined, now);
    expect(r.verdict).toBe("SKIP");
    expect(r.reasons.join(" ")).toMatch(/SOLD OUT/);
    expect(r.remaining).toBe(0n);
  });

  it("never says WORTH A LOOK without price data", async () => {
    const r = await enrich(hit(), rpcWith(10n, 1000n, true), undefined, now);
    expect(r.verdict).toBe("SKIP");
    expect(r.reasons.join(" ")).toMatch(/price unknown/);
  });

  it("skips a stage that is about to close", async () => {
    const r = await enrich(hit({ endTime: now + 120 }), rpcWith(10n, 1000n, true), undefined, now);
    expect(r.reasons.join(" ")).toMatch(/ends in/);
  });
});

describe("bridge guard", () => {
  const OWN = getAddress("0xD20A20353060F015fc32ebB86c68aB51013dE74B");
  const OTHER = getAddress("0x000000000000000000000000000000000000dEaD");
  const DEPOSIT = "0x4cD00E387622C35bDDB9b4c962C136462338BC31";
  const chains = [
    { id: 999, name: "hyperevm", httpRpcUrl: "x", currency: { symbol: "HYPE", decimals: 18 }, protocol: { v2: { depository: DEPOSIT } } },
    { id: 99901, name: "elysium", httpRpcUrl: "y", currency: { symbol: "HYPE", decimals: 18 }, protocol: { v2: { depository: DEPOSIT } } },
  ];
  const quote = (over: any = {}) => ({
    requestId: "0xabc",
    steps: over.steps ?? [{ id: "deposit", kind: "transaction", items: [{ data: { to: over.to ?? DEPOSIT, value: over.value ?? "100000000000000000", data: "0x1234", chainId: 999 } }] }],
    fees: { gas: { amountUsd: over.gas ?? "0.001" } },
    details: {
      recipient: over.recipient ?? OWN,
      currencyIn: { currency: { address: over.curIn ?? "0x0000000000000000000000000000000000000000" }, amountUsd: over.usdIn ?? "7.00" },
      currencyOut: { currency: { address: "0x0000000000000000000000000000000000000000", symbol: "HYPE" }, amountUsd: over.usdOut ?? "6.99", amountFormatted: "0.0999" },
    },
  });
  const mock = (q: unknown) =>
    vi.stubGlobal("fetch", async (url: string) => ({ ok: true, status: 200, json: async () => (String(url).endsWith("/chains") ? { chains } : q) }));
  const req = (o: any = {}) => ({
    fromChainId: 999, toChainId: 99901, amountWei: 100000000000000000n, sender: OWN, recipient: OWN, ownWallets: [OWN],
    maxUsdPerBridge: 15, maxUsdPerDay: 15, maxFeePct: 8, maxFeeUsd: 0.05, ledgerFile: "no-such-dir/none.json", ...o,
  });
  afterEach(() => vi.unstubAllGlobals());

  it("accepts a clean native quote", async () => {
    mock(quote());
    const p = await planBridge(req());
    expect(p.feeUsd).toBeCloseTo(0.011, 3);
  });
  it("refuses a transaction to any address other than Relay's published depository", async () => {
    mock(quote({ to: OTHER }));
    await expect(planBridge(req())).rejects.toThrow(/depository/);
  });
  it("refuses extra steps such as an approval", async () => {
    mock(quote({ steps: [{ kind: "transaction", items: [{}] }, { kind: "transaction", items: [{}] }] }));
    await expect(planBridge(req())).rejects.toThrow(/extra steps/);
  });
  it("refuses when the value differs from the request", async () => {
    mock(quote({ value: "200000000000000000" }));
    await expect(planBridge(req())).rejects.toThrow(/value differs/);
  });
  it("refuses a recipient that is not your own wallet", async () => {
    mock(quote());
    await expect(planBridge(req({ recipient: OTHER }))).rejects.toThrow(/not one of your own/);
  });
  it("refuses a quote that comes back for someone else", async () => {
    mock(quote({ recipient: OTHER }));
    await expect(planBridge(req())).rejects.toThrow(/recipient differs/);
  });
  it("refuses a token (non-native) quote", async () => {
    mock(quote({ curIn: "0x1111111111111111111111111111111111111111" }));
    await expect(planBridge(req())).rejects.toThrow(/native/);
  });
  it("enforces the $0.05 fee ceiling and the per-bridge cap", async () => {
    mock(quote({ usdOut: "6.90" }));
    await expect(planBridge(req())).rejects.toThrow(/over your limit/);
    mock(quote());
    await expect(planBridge(req({ maxUsdPerBridge: 5 }))).rejects.toThrow(/per-bridge cap/);
  });
});
