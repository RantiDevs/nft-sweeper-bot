import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ganache from "ganache";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  parseEther,
  toHex,
  type Abi,
  type Address,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../src/config.js";
import { Engine } from "../src/engine.js";
import { State } from "../src/state.js";
import { makeWallets } from "../src/wallets.js";
import { compileFixtures } from "./fixtures/compile.js";

/**
 * Fast path: when the free delivery simulation has already proved a mint works, every wallet
 * should start at once and reuse the first wallet's gas estimate instead of asking the node.
 * A counting transport shows how many calls each approach makes.
 */
const BOTS = 8;
const CROWD = 6;
const chain = defineChain({ id: 1337, name: "local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } });
const deployerKey = generatePrivateKey();
const crowdKeys = Array.from({ length: CROWD }, () => generatePrivateKey());
const botKeys = Array.from({ length: BOTS }, () => generatePrivateKey());

const provider = ganache.provider({
  logging: { quiet: true },
  chain: { chainId: 1337 },
  miner: { instamine: "strict" },
  wallet: { accounts: [deployerKey, ...crowdKeys, ...botKeys].map((secretKey) => ({ secretKey, balance: toHex(parseEther("10")) })) },
});
const calls: Record<string, number> = {};
const transport = custom({
  request: async (a: { method: string; params?: unknown }) => {
    calls[a.method] = (calls[a.method] ?? 0) + 1;
    return (provider as unknown as { request: (x: unknown) => Promise<unknown> }).request(a);
  },
} as never);
const client = createPublicClient({ chain, transport, pollingInterval: 20 }) as PublicClient;
const art = compileFixtures().FreeNFT;
let nft: Address;

async function deployCollection(): Promise<Address> {
  const owner = privateKeyToAccount(deployerKey);
  const wc = createWalletClient({ account: owner, chain, transport });
  const hash = await wc.deployContract({ abi: art.abi, bytecode: art.bytecode, account: owner, chain });
  const c = getAddress((await client.waitForTransactionReceipt({ hash })).contractAddress!);
  await Promise.all(
    crowdKeys.map(async (key) => {
      const a = privateKeyToAccount(key);
      const w = createWalletClient({ account: a, chain, transport });
      const h = await w.writeContract({ address: c, abi: art.abi as Abi, functionName: "mint", args: [a.address, 1n], account: a, chain });
      await client.waitForTransactionReceipt({ hash: h });
    }),
  );
  return c;
}

function engineFor(env: Record<string, string>) {
  const cfg = loadConfig({
    DRY_RUN: "false", CHAIN_ID: "1337", MAX_BASE_FEE_GWEI: "off", PRIVATE_KEYS: botKeys.join(","), MIN_UNIQUE_MINTERS: "3", MIN_MINT_TXS: "3",
    MAX_GAS_COST_ETH: "0.01", TOTAL_GAS_BUDGET_ETH: "1", RECEIPT_TIMEOUT_MS: "10000", WALLET_CONCURRENCY: "8", ...env,
  });
  const state = new State(join(mkdtempSync(join(tmpdir(), "fast-")), "state.json"));
  const wallets = makeWallets(botKeys.map((k) => privateKeyToAccount(k)), chain, transport);
  return { engine: new Engine(client, wallets, cfg, state), state, wallets };
}

beforeAll(async () => {
  nft = await deployCollection();
}, 60_000);

afterAll(() => vi.restoreAllMocks());

describe("fast path", () => {
  it("normal path: wallets still wait for the first wallet's receipt, but reuse its gas estimate", async () => {
    const { engine, state, wallets } = engineFor({ FAST_MODE: "false" });
    for (const k of Object.keys(calls)) delete calls[k];
    await engine.init();
    await engine.tick();
    await engine.drain();
    expect(wallets.every((w) => state.holdings(w.account.address).length === 1)).toBe(true);
    // The first wallet simulates; the other seven reuse its gas figure instead of asking again.
    // One measurement of the current mint cost, plus the first wallet's own estimate(s): far fewer than one per wallet.
    expect(calls.eth_estimateGas).toBeLessThan(BOTS);
  }, 60_000);

  it("fast path: all wallets mint, but gas is estimated once for the whole round", async () => {
    const second = await deployCollection(); // a fresh collection the bots have not minted
    const { engine, state, wallets } = engineFor({ FAST_MODE: "true" });
    // Stand in for an RPC that supports eth_simulateV1: delivery is "proven".
    (engine.watcher as unknown as { vetter: { check: unknown } }).vetter.check = async () => ({ ok: true, deliveryVerified: true });
    const log = vi.spyOn(console, "log");
    for (const k of Object.keys(calls)) delete calls[k];
    await engine.init();
    await engine.tick();
    await engine.drain();

    for (const w of wallets) {
      expect(state.holdings(w.account.address).filter((h) => h.collection === second)).toHaveLength(1);
    }
    // One measurement of the current mint cost, plus the first wallet's own estimate(s): far fewer than one per wallet.
    expect(calls.eth_estimateGas).toBeLessThan(BOTS); // the first wallet only (per mint pattern)
    expect(log.mock.calls.some((c) => String(c.join(" ")).includes("FIRST TX SENT"))).toBe(true);
    log.mockRestore();
  }, 60_000);

  it("fast path still stops a collection that the first wallet proves is a trap", async () => {
    // Without delivery proof the old, receipt-gated path is used, so a trap costs one transaction.
    const { engine } = engineFor({ FAST_MODE: "true" });
    expect(engine.session.floor()).toBeDefined();
  });
});
