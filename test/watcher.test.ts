import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { assertChain } from "../src/rpc.js";
import { UserStore, defaultSettings } from "../src/tg/store.js";
import { Watcher } from "../src/watcher.js";

function fakeClient(opts: { failIngest?: boolean } = {}) {
  let head = 100n;
  return {
    getBlockNumber: vi.fn(async () => head++),
    request: vi.fn(async () => {
      if (opts.failIngest) throw new Error("range too large");
      return [];
    }),
    getTransaction: vi.fn(),
    getChainId: vi.fn(async () => 4663),
  } as unknown as PublicClient;
}

describe("Watcher", () => {
  it("skips a block range that keeps failing, alerts, and keeps going", async () => {
    const alerts: string[] = [];
    const w = new Watcher(fakeClient({ failIngest: true }), { windowBlocks: 4, pollIntervalMs: 1, onAlert: (t) => alerts.push(t) });
    w.subscribe({ wants: () => true, owns: () => false, floor: () => ({ minUniqueMinters: 1, minMintTxs: 1 }), offer: () => {} });
    await w.init();
    for (let i = 0; i < 4; i++) await expect(w.tick()).rejects.toThrow(/range too large/);
    // 5th failure: the bad range is skipped and alerted. The same tick then moves on to the
    // newest block, which fails afresh (counter restarted), so the tick still throws.
    await expect(w.tick()).rejects.toThrow(/range too large/);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/Skipped blocks/);
    await expect(w.tick()).rejects.toThrow(/range too large/);
    expect(alerts).toHaveLength(1); // not re-alerted until another 5 failures
  });

  it("only dispatches to subscribers that are active, using the lowest floor", async () => {
    const offered: string[] = [];
    const w = new Watcher(fakeClient(), { windowBlocks: 4, pollIntervalMs: 1 });
    const hotFloor = vi.spyOn(w.detector, "hot");
    w.subscribe({ wants: () => true, owns: () => false, floor: () => undefined, offer: () => offered.push("paused") });
    await w.init();
    await w.tick();
    expect(hotFloor).not.toHaveBeenCalled(); // nobody active → no work

    w.subscribe({ wants: () => true, owns: () => false, floor: () => ({ minUniqueMinters: 15, minMintTxs: 20 }), offer: () => {} });
    w.subscribe({ wants: () => true, owns: () => false, floor: () => ({ minUniqueMinters: 1, minMintTxs: 1 }), offer: () => {} });
    await w.tick();
    expect(hotFloor).toHaveBeenCalledWith({ minUniqueMinters: 1, minMintTxs: 1 });
  });

  it("reports a stalled chain via lastOkAt", async () => {
    const w = new Watcher(fakeClient(), { windowBlocks: 4, pollIntervalMs: 1 });
    const before = w.lastOkAt;
    await new Promise((r) => setTimeout(r, 5));
    await w.init();
    await w.tick();
    expect(w.lastOkAt).toBeGreaterThan(before);
  });
});

describe("startup and storage safety", () => {
  it("assertChain rejects an RPC serving a different chain", async () => {
    await expect(assertChain(fakeClient(), 4663)).resolves.toBeUndefined();
    await expect(assertChain(fakeClient(), 1)).rejects.toThrow(/chain 4663 but CHAIN_ID is 1/);
  });

  it("keeps a .bak of the previous users.json on every save", () => {
    const file = join(mkdtempSync(join(tmpdir(), "bak-")), "users.json");
    const store = new UserStore(file);
    const rec = store.create({
      id: 7, role: "user", status: "active", createdAt: 0, wallets: [],
      settings: defaultSettings({ maxGasCostEth: "0.001", totalGasBudgetEth: "0.01", minUniqueMinters: 5, minMintTxs: 5 }),
    });
    expect(existsSync(`${file}.bak`)).toBe(false);
    rec.wallets.push({ address: "0x0000000000000000000000000000000000000001", enc: "v1.x.y.z" });
    store.save();
    const bak = JSON.parse(readFileSync(`${file}.bak`, "utf8"));
    expect(bak.users["7"].wallets).toHaveLength(0); // the version before the change
    expect(JSON.parse(readFileSync(file, "utf8")).users["7"].wallets).toHaveLength(1);
    copyFileSync(`${file}.bak`, `${file}.restored`); // restoring is a plain copy
  });
});
