import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const mintDrop = vi.fn();
vi.mock("../src/mintdrop.js", () => ({ mintDrop: (o: unknown) => mintDrop(o) }));

const { AutoMinter } = await import("../src/tg/automint.js");

const NFT = "0x168dd252b47ff4a63dfa98b2f0b573df4df3f3ed" as const;
const key = generatePrivateKey();
const settings = (over: Record<string, unknown> = {}) => ({ dryRun: true, autoMint: true, ...over });

function setup(user: Record<string, unknown> = {}) {
  const messages: string[] = [];
  const rec = { id: 1, status: "active", wallets: [{ address: privateKeyToAccount(key).address }], settings: settings(), ...user };
  const am = new AutoMinter({
    hub: { exportKeys: () => [{ label: "w01", address: rec.wallets[0].address, key }] } as any,
    store: { all: () => [rec], get: () => rec } as any,
    dataDir: mkdtempSync(join(tmpdir(), "automint-")),
    notify: (_id, html) => void messages.push(html),
  });
  return { am, rec, messages };
}

const hit = (over: Record<string, unknown> = {}) =>
  ({
    chain: "Base", chainId: 8453, symbol: "ETH", state: "LIVE", opensInSec: -5, verdict: "WORTH A LOOK", reasons: [], nativeUsd: 2000,
    drop: { platform: "seadrop", nft: NFT, mintTo: NFT, priceWei: 0n, startTime: 1, endTime: 9_999_999_999, maxPerWallet: 1, block: 1n },
    ...over,
  }) as any;

const flush = () => new Promise((r) => setTimeout(r, 60));

beforeEach(() => {
  mintDrop.mockReset();
  mintDrop.mockResolvedValue({ summary: "1 minted", results: [{ address: "0x0", status: "minted", note: "minted", costWei: 5_000_000_000_000n }] });
});

describe("auto-mint", () => {
  it("does nothing for a user who has not turned it on", async () => {
    const { am } = setup({ settings: settings({ autoMint: false }) });
    am.consider(hit());
    await flush();
    expect(mintDrop).not.toHaveBeenCalled();
  });

  it("in dry-run mode it simulates (execute=false) and never sends", async () => {
    const { am, messages } = setup();
    am.consider(hit());
    await flush();
    expect(mintDrop).toHaveBeenCalledTimes(1);
    expect(mintDrop.mock.calls[0][0].execute).toBe(false);
    expect(messages.join(" ")).toMatch(/dry run/i);
  });

  it("in live mode it sends, and turns the dollar ceiling into a wei ceiling", async () => {
    const { am } = setup({ settings: settings({ dryRun: false, autoMintMaxGasUsd: 0.2 }) });
    am.consider(hit()); // 1 ETH = $2000, so $0.20 = 0.0001 ETH
    await flush();
    const o = mintDrop.mock.calls[0][0];
    expect(o.execute).toBe(true);
    expect(o.maxGasWei).toBe(100_000_000_000_000n);
  });

  it("tries a collection only once", async () => {
    const { am } = setup();
    am.consider(hit());
    am.consider(hit());
    await flush();
    expect(mintDrop).toHaveBeenCalledTimes(1);
  });

  it("refuses when it cannot price the native coin in dollars", async () => {
    const { am, messages } = setup();
    am.consider(hit({ nativeUsd: undefined }));
    await flush();
    expect(mintDrop).not.toHaveBeenCalled();
    expect(messages.join(" ")).toMatch(/no dollar price/);
  });

  it("stops for the day once the daily limit is spent", async () => {
    // 0.005 ETH of gas at $2000 = $10, far above a $1 daily limit
    mintDrop.mockResolvedValue({ summary: "1 minted", results: [{ address: "0x0", status: "minted", note: "m", costWei: 5_000_000_000_000_000n }] });
    const { am, messages } = setup({ settings: settings({ dryRun: false }) });
    am.consider(hit());
    await flush();
    am.consider(hit({ drop: { platform: "seadrop", nft: "0x000000000000000000000000000000000000bEEF", mintTo: NFT, priceWei: 0n, startTime: 2, endTime: 9_999_999_999, maxPerWallet: 1, block: 1n } }));
    await flush();
    expect(mintDrop).toHaveBeenCalledTimes(1);
    expect(messages.join(" ")).toMatch(/limit is used up/);
  });

  it("respects the switch being turned off while it waited", async () => {
    const { am, rec } = setup();
    am.consider(hit({ drop: { platform: "seadrop", nft: NFT, mintTo: NFT, priceWei: 0n, startTime: Math.floor(Date.now() / 1000) + 1, endTime: 9_999_999_999, maxPerWallet: 1, block: 1n } }));
    (rec.settings as any).autoMint = false;
    await new Promise((r) => setTimeout(r, 1300));
    expect(mintDrop).not.toHaveBeenCalled();
    am.stop();
  });
});
