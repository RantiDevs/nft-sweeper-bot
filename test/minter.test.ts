import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseEther, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { GasBudget } from "../src/budget.js";
import type { FeeOracle } from "../src/fees.js";
import { loadConfig } from "../src/config.js";
import type { HotMint } from "../src/detector.js";
import { TRANSFER_TOPIC, ZERO_TOPIC } from "../src/logs.js";
import { mintFor, type MintContext } from "../src/minter.js";
import { NonceManager } from "../src/nonce.js";
import { State } from "../src/state.js";
import type { Wallet } from "../src/wallets.js";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const C = "0x00000000000000000000000000000000000000C1" as Address;
const them = "0x3333333333333333333333333333333333333333" as Address;
const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;

const template = {
  collection: C, txHash: ZERO_TOPIC, blockNumber: 1n, minter: them, target: C, value: 0n,
  input: `0x40c10f19${pad(them).slice(2)}${"0".repeat(63)}1` as Hex, // mint(address,uint256)
};
const hot: HotMint = { collection: C, uniqueMinters: 20, mintTxs: 30, templates: [template] };

function fakeFees(maxFeePerGas: bigint): FeeOracle {
  return {
    get: async () => ({ maxFeePerGas, maxPriorityFeePerGas: 0n }),
    bump: async (p: { maxFeePerGas: bigint }) => ({ maxFeePerGas: p.maxFeePerGas * 2n, maxPriorityFeePerGas: 1n }),
  } as unknown as FeeOracle;
}

function setup(env: Record<string, string>, receiptTo: Address = account.address) {
  const cfg = loadConfig({ DRY_RUN: "false", PRIVATE_KEYS: `0x${"11".repeat(32)}`, ...env });
  const state = new State(join(mkdtempSync(join(tmpdir(), "sweeper-")), "state.json"));
  const pc = {
    estimateGas: vi.fn().mockResolvedValue(100_000n),
    getBalance: vi.fn().mockResolvedValue(parseEther("1")),
    getTransactionCount: vi.fn().mockResolvedValue(7),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({
      status: "success",
      gasUsed: 80_000n,
      effectiveGasPrice: 10_000_000n,
      logs: [{ address: C, topics: [TRANSFER_TOPIC, ZERO_TOPIC, pad(receiptTo), pad("0x2a")], data: "0x" }],
    }),
  };
  const sendTransaction = vi.fn().mockResolvedValue(`0x${"aa".repeat(32)}`);
  const wallet = { label: "w01", account, client: { chain: undefined, sendTransaction } } as unknown as Wallet;
  const publicClient = pc as unknown as PublicClient;
  const ctx: MintContext = {
    publicClient, cfg, state,
    nonces: new NonceManager(publicClient),
    budget: new GasBudget(cfg.totalGasBudgetWei, () => state.gasSpent()),
    fees: fakeFees(10_000_000n),
    preferred: new Map(),
  };
  return { cfg, state, pc, wallet, sendTransaction, ctx };
}

describe("mintFor", () => {
  it("sends retargeted calldata with zero value, local nonce, and records holdings", async () => {
    const { state, wallet, sendTransaction, ctx } = setup({});
    const res = await mintFor(hot, wallet, ctx);
    expect(res.status).toBe("minted");
    const sent = sendTransaction.mock.calls[0][0];
    expect(sent.value).toBe(0n);
    expect(sent.to).toBe(C);
    expect(sent.nonce).toBe(7);
    expect(sent.data).toContain(account.address.slice(2).toLowerCase());
    expect(sent.data).not.toContain(them.slice(2).toLowerCase());
    expect(state.holdings(account.address)).toMatchObject([{ collection: C, tokenId: "42", standard: "erc721" }]);
    expect(state.gasSpent()).toBe(80_000n * 10_000_000n);

    const again = await mintFor(hot, wallet, ctx);
    expect(again).toMatchObject({ status: "skipped", reason: "per-collection limit reached" });
  });

  it("does not send in dry-run mode", async () => {
    const { wallet, sendTransaction, ctx } = setup({ DRY_RUN: "true" });
    expect((await mintFor(hot, wallet, ctx)).status).toBe("dry-run");
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("falls back to the next template when the first reverts", async () => {
    const { pc, wallet, sendTransaction, ctx } = setup({});
    const claim = { ...template, txHash: `0x${"01".repeat(32)}` as Hex, input: "0x4e71d92d" as Hex };
    pc.estimateGas.mockRejectedValueOnce(new Error("execution reverted: max per wallet"));
    const res = await mintFor({ ...hot, templates: [template, claim] }, wallet, ctx);
    expect(res.status).toBe("minted");
    expect(sendTransaction.mock.calls[0][0].data).toBe("0x4e71d92d");
    expect(ctx.preferred.get(C)).toContain("0x4e71d92d");
  });

  it("treats a revert as final but an RPC error as retryable", async () => {
    const a = setup({});
    a.pc.estimateGas.mockRejectedValue(new Error("execution reverted: sold out"));
    expect(await mintFor(hot, a.wallet, a.ctx)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/^simulation reverted/) });
    const b = setup({});
    b.pc.estimateGas.mockRejectedValue(new Error("HTTP request failed: 502"));
    expect(await mintFor(hot, b.wallet, b.ctx)).toMatchObject({ status: "skipped", retry: true });
    expect(b.sendTransaction).not.toHaveBeenCalled();
  });

  it("skips when worst-case gas exceeds the per-tx cap", async () => {
    const { wallet, sendTransaction, ctx } = setup({});
    ctx.fees = fakeFees(parseEther("0.0001"));
    expect((await mintFor(hot, wallet, ctx)).status).toBe("skipped");
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("skips wallets without enough gas balance", async () => {
    const { pc, wallet, sendTransaction, ctx } = setup({});
    pc.getBalance.mockResolvedValue(1n);
    expect(await mintFor(hot, wallet, ctx)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/^balance/) });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("respects the global gas budget", async () => {
    const { wallet, sendTransaction, ctx } = setup({ TOTAL_GAS_BUDGET_ETH: "0.0000001" });
    expect(await mintFor(hot, wallet, ctx)).toMatchObject({ reason: expect.stringMatching(/BUDGET/) });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("marks the collection bad when the token goes to someone else", async () => {
    const { state, wallet, ctx } = setup({}, them);
    expect((await mintFor(hot, wallet, ctx)).status).toBe("failed");
    expect(state.isBad(C)).toBe(true);
  });

  it("resyncs the nonce and retries once on a nonce error", async () => {
    const { pc, wallet, sendTransaction, ctx } = setup({});
    sendTransaction.mockRejectedValueOnce(new Error("nonce too low"));
    pc.getTransactionCount.mockResolvedValueOnce(7).mockResolvedValueOnce(8);
    expect((await mintFor(hot, wallet, ctx)).status).toBe("minted");
    expect(sendTransaction.mock.calls.map((c) => c[0].nonce)).toEqual([7, 8]);
  });

  it("replaces a stuck tx with the same nonce and a higher fee", async () => {
    const { pc, wallet, sendTransaction, ctx, state } = setup({});
    const ok = await pc.waitForTransactionReceipt();
    pc.waitForTransactionReceipt.mockReset();
    pc.waitForTransactionReceipt.mockRejectedValueOnce(new Error("Timed out while waiting for transaction")).mockResolvedValueOnce(ok);
    expect((await mintFor(hot, wallet, ctx)).status).toBe("minted");
    const [first, second] = sendTransaction.mock.calls.map((c) => c[0]);
    expect(second.nonce).toBe(first.nonce);
    expect(second.maxFeePerGas).toBeGreaterThan(first.maxFeePerGas);
    expect(state.holdings(account.address)).toHaveLength(1);
  });

  it("does not bump past the per-tx gas cap", async () => {
    // cost at 10M wei/gas * 125k gas = 0.00000125 ETH; the bump doubles it past a 0.000002 cap.
    const { pc, wallet, sendTransaction, ctx } = setup({ MAX_GAS_COST_ETH: "0.000002" });
    pc.waitForTransactionReceipt.mockRejectedValue(new Error("Timed out while waiting for transaction"));
    expect((await mintFor(hot, wallet, ctx)).status).toBe("failed");
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("FeeOracle", () => {
  it("bids baseFee * multiplier + tip and bumps by at least 30%", async () => {
    const { FeeOracle } = await import("../src/fees.js");
    const client = {
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 100n }),
      estimateMaxPriorityFeePerGas: vi.fn().mockResolvedValue(5n),
    };
    const o = new FeeOracle(client as never, { multiplier: 2, minPriorityFeeWei: 0n });
    expect(await o.get()).toEqual({ maxFeePerGas: 205n, maxPriorityFeePerGas: 5n });
    const b = await o.bump({ maxFeePerGas: 205n, maxPriorityFeePerGas: 5n });
    expect(b.maxFeePerGas).toBeGreaterThanOrEqual(266n);
    expect(b.maxPriorityFeePerGas).toBeGreaterThanOrEqual(6n);
  });
});
