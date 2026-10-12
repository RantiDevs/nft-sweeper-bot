import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseEther, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../src/config.js";
import type { HotMint } from "../src/detector.js";
import { TRANSFER_TOPIC, ZERO_TOPIC } from "../src/logs.js";
import { mintFor, type Wallet } from "../src/minter.js";
import { State } from "../src/state.js";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const C = "0x00000000000000000000000000000000000000C1" as Address;
const them = "0x3333333333333333333333333333333333333333" as Address;
const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;

const hot: HotMint = {
  collection: C, uniqueMinters: 20, mintTxs: 30,
  template: {
    collection: C, txHash: ZERO_TOPIC, blockNumber: 1n, minter: them, target: C, value: 0n,
    input: `0x40c10f19${pad(them).slice(2)}${"0".repeat(63)}1` as Hex, // mint(address,uint256)
  },
};

function setup(env: Record<string, string>, receiptTo: Address = account.address) {
  const cfg = loadConfig({ DRY_RUN: "false", PRIVATE_KEYS: `0x${"11".repeat(32)}`, ...env });
  const state = new State(join(mkdtempSync(join(tmpdir(), "sweeper-")), "state.json"));
  const pc = {
    call: vi.fn().mockResolvedValue({ data: "0x" }),
    estimateGas: vi.fn().mockResolvedValue(100_000n),
    estimateFeesPerGas: vi.fn().mockResolvedValue({ maxFeePerGas: 10_000_000n, maxPriorityFeePerGas: 0n }),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({
      status: "success",
      logs: [{ address: C, topics: [TRANSFER_TOPIC, ZERO_TOPIC, pad(receiptTo), pad("0x01")] }],
    }),
  };
  const sendTransaction = vi.fn().mockResolvedValue(`0x${"aa".repeat(32)}`);
  const wallet = { account, client: { chain: undefined, sendTransaction } } as unknown as Wallet;
  return { cfg, state, pc: pc as unknown as PublicClient & typeof pc, wallet, sendTransaction };
}

describe("mintFor", () => {
  it("sends retargeted calldata with zero value and records the mint", async () => {
    const { cfg, state, pc, wallet, sendTransaction } = setup({});
    const res = await mintFor(hot, wallet, pc, cfg, state);
    expect(res.status).toBe("minted");
    const sent = sendTransaction.mock.calls[0][0];
    expect(sent.value).toBe(0n);
    expect(sent.to).toBe(C);
    expect(sent.data).toContain(account.address.slice(2).toLowerCase());
    expect(sent.data).not.toContain(them.slice(2).toLowerCase());
    expect(state.mintCount(C, account.address)).toBe(1);

    const again = await mintFor(hot, wallet, pc, cfg, state);
    expect(again).toMatchObject({ status: "skipped", reason: "per-collection limit reached" });
  });

  it("does not send in dry-run mode", async () => {
    const { cfg, state, pc, wallet, sendTransaction } = setup({ DRY_RUN: "true" });
    expect((await mintFor(hot, wallet, pc, cfg, state)).status).toBe("dry-run");
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("skips when simulation reverts", async () => {
    const { cfg, state, pc, wallet, sendTransaction } = setup({});
    pc.call.mockRejectedValue(new Error("execution reverted: max per wallet"));
    expect((await mintFor(hot, wallet, pc, cfg, state)).status).toBe("skipped");
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("skips when worst-case gas exceeds the cap", async () => {
    const { cfg, state, pc, wallet, sendTransaction } = setup({});
    pc.estimateFeesPerGas.mockResolvedValue({ maxFeePerGas: parseEther("0.0001"), maxPriorityFeePerGas: 0n });
    expect((await mintFor(hot, wallet, pc, cfg, state)).status).toBe("skipped");
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("marks the collection bad when the token goes to someone else", async () => {
    const { cfg, state, pc, wallet } = setup({}, them);
    expect((await mintFor(hot, wallet, pc, cfg, state)).status).toBe("failed");
    expect(state.isBad(C)).toBe(true);
  });
});
