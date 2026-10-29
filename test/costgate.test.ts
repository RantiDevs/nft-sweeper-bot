import { describe, expect, it, vi } from "vitest";
import { parseEther, type Address, type PublicClient } from "viem";
import { loadConfig } from "../src/config.js";
import type { HotMint } from "../src/detector.js";
import { FeeOracle } from "../src/fees.js";
import { Session, type SessionEvent } from "../src/session.js";
import { Notifier } from "../src/tg/notify.js";

const C = "0x00000000000000000000000000000000000000c1" as Address;
const hot: HotMint = {
  collection: C, uniqueMinters: 3, mintTxs: 3,
  templates: [{ collection: C, txHash: `0x${"11".repeat(32)}`, blockNumber: 1n, minter: "0x3333333333333333333333333333333333333333", target: C, input: "0x1249c58b", value: 0n }],
};
const wallet = { label: "w01", account: { address: "0x1111111111111111111111111111111111111111" }, client: {} };

describe("FeeOracle.mintCost", () => {
  const client = (gas: bigint, base: bigint) => ({
    getBlock: vi.fn(async () => ({ baseFeePerGas: base })),
    estimateMaxPriorityFeePerGas: vi.fn(async () => 0n),
    estimateGas: vi.fn(async () => gas),
  });

  it("prices a typical mint from a real gas estimate: data-posting part plus execution", async () => {
    const c = client(10_650_000n, 21_000_000n); // today: 10.65M gas for the data part, 0.021 gwei
    const oracle = new FeeOracle(c as never, { multiplier: 2, minPriorityFeeWei: 0n });
    const { gas, costWei } = await oracle.mintCost(c as never);
    expect(gas).toBe(10_800_000n); // + 150k for the mint's own execution
    expect(costWei).toBe(10_800_000n * 21_000_000n);
    expect(Number(costWei) / 1e18).toBeCloseTo(0.000227, 5); // about $0.52 at $2300
  });

  it("measures once per 20 seconds, then reuses the figure", async () => {
    const c = client(15_000n, 21_000_000n); // the cheap regime: $0.0055 mints
    const oracle = new FeeOracle(c as never, { multiplier: 2, minPriorityFeeWei: 0n });
    const cheap = await oracle.mintCost(c as never);
    await oracle.mintCost(c as never);
    expect(c.estimateGas).toHaveBeenCalledTimes(1);
    expect(Number(cheap.costWei) / 1e18 * 2300).toBeLessThan(0.01);
  });
});

describe("holding off while gas is too dear", () => {
  function setup(costWei: () => bigint, capEth = "0.00002") {
    const cfg = loadConfig({ DRY_RUN: "true", CHAIN_ID: "1337", MAX_GAS_COST_ETH: capEth }, { requireWallets: false });
    const events: SessionEvent[] = [];
    const vet = vi.fn(async () => ({ ok: false as const, reason: "x", retryable: true }));
    const state = { isBad: () => false, mintCount: () => 0, markBad: vi.fn(), holdings: () => [], gasSpent: () => 0n };
    const s = new Session({
      publicClient: { getBalance: vi.fn(async () => 0n) } as unknown as PublicClient,
      feeOracle: { mintCost: async () => ({ gas: 1n, costWei: costWei() }) } as never,
      state: state as never,
      config: () => cfg,
      wallets: () => [wallet as never],
      onEvent: (e) => events.push(e),
    });
    const helpers = { isNft: async () => true, probe: async () => "reverts" as const, vet };
    return { s, vet, events, helpers };
  }

  it("skips every collection check and tells the user once, while a mint costs more than the cap", async () => {
    const { s, vet, events, helpers } = setup(() => parseEther("0.0002")); // $0.46 against a $0.046 cap
    s.offer([hot], helpers);
    await s.drain();
    expect(vet).not.toHaveBeenCalled(); // no checks, no RPC calls for the collection
    const waits = events.filter((e) => e.type === "gas-wait");
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ costWei: parseEther("0.0002"), capWei: parseEther("0.00002") });
  });

  it("goes ahead as soon as the measured cost drops under the cap", async () => {
    let cost = parseEther("0.0002");
    const { s, vet, helpers } = setup(() => cost);
    s.offer([hot], helpers);
    await s.drain();
    expect(vet).not.toHaveBeenCalled();
    cost = parseEther("0.000003"); // back to the cheap regime
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 40_000); // past the 15 s recheck and the 20 s measurement
    s.offer([hot], helpers);
    await s.drain();
    expect(vet).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});

describe("the Telegram message", () => {
  it("explains the wait in dollars and is sent at most every 15 minutes", async () => {
    const send = vi.fn(async () => {});
    const n = new Notifier({ sendMessage: send }, [], undefined, () => 2300);
    const e = { type: "gas-wait" as const, costWei: parseEther("0.0002"), capWei: parseEther("0.00002") };
    expect(n.format(e)).toMatch(/Waiting for cheaper gas/);
    expect(n.format(e)).toContain("$0.46");
    expect(n.format(e)).toContain("$0.046");
    n.event(7, e);
    n.event(7, e);
    await n.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
