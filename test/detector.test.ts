import { describe, expect, it } from "vitest";
import { type Address, type Hex } from "viem";
import { MintDetector, type MintObservation } from "../src/detector.js";

const C = "0x00000000000000000000000000000000000000c1" as Address;
const addr = (i: number) => `0x${(0xa11ce000 + i).toString(16).padStart(40, "0")}` as Address;
const hash = (i: number) => `0x${i.toString(16).padStart(64, "0")}` as Hex;

function obs(i: number, over: Partial<MintObservation> = {}): MintObservation {
  return {
    collection: C, txHash: hash(i), blockNumber: BigInt(100 + i), minter: addr(i),
    target: C, input: "0x1249c58b", value: 0n, ...over,
  };
}

const opts = { windowBlocks: 50, minUniqueMinters: 3, minMintTxs: 3 };

describe("MintDetector", () => {
  it("flags a collection once enough distinct wallets mint for free", () => {
    const d = new MintDetector(opts);
    d.add(obs(1)); d.add(obs(2));
    expect(d.hot()).toHaveLength(0);
    d.add(obs(3));
    const [hot] = d.hot();
    expect(hot.collection).toBe(C);
    expect(hot.uniqueMinters).toBe(3);
    expect(hot.templates[0].txHash).toBe(hash(3));
  });

  it("does not count one wallet spamming as unique minters", () => {
    const d = new MintDetector(opts);
    for (let i = 1; i <= 10; i++) d.add(obs(i, { minter: addr(1) }));
    expect(d.hot()).toHaveLength(0);
  });

  it("ignores duplicate tx hashes", () => {
    const d = new MintDetector({ ...opts, minUniqueMinters: 1 });
    d.add(obs(1)); d.add(obs(1)); d.add(obs(1));
    expect(d.hot()).toHaveLength(0);
  });

  it("disqualifies collections where anyone paid", () => {
    const d = new MintDetector(opts);
    d.add(obs(1)); d.add(obs(2)); d.add(obs(3, { value: 1n }));
    expect(d.hot()).toHaveLength(0);
  });

  it("never uses approval/transfer calls as a template", () => {
    const d = new MintDetector(opts);
    for (let i = 1; i <= 3; i++) d.add(obs(i, { input: "0xa22cb465" }));
    expect(d.hot()).toHaveLength(0);
  });

  it("drops activity older than the window", () => {
    const d = new MintDetector(opts);
    d.add(obs(1)); d.add(obs(2)); d.add(obs(3));
    d.prune(160n);
    expect(d.hot()).toHaveLength(0);
  });

  it("ranks call patterns by how many distinct wallets used them", () => {
    const d = new MintDetector({ ...opts, minUniqueMinters: 1, minMintTxs: 1 });
    const pad = (a: string) => a.slice(2).toLowerCase().padStart(64, "0");
    // 3 wallets use mint(address self, 1); 1 wallet uses claim().
    for (let i = 1; i <= 3; i++) {
      d.add(obs(i, { input: `0x40c10f19${pad(addr(i))}${"0".repeat(63)}1` as Hex }));
    }
    d.add(obs(9, { input: "0x4e71d92d", blockNumber: 999n }));
    const [hot] = d.hot();
    expect(hot.templates.map((t) => t.input.slice(0, 10))).toEqual(["0x40c10f19", "0x4e71d92d"]);
  });

  it("applies per-collection thresholds (allowlist snipe mode)", () => {
    const d = new MintDetector({ ...opts, thresholdsFor: (c) => (c === C ? { minUniqueMinters: 1, minMintTxs: 1 } : undefined) });
    d.add(obs(1));
    expect(d.hot()).toHaveLength(1);
  });
});
