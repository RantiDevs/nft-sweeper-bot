import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ganache from "ganache";
import { beforeAll, describe, expect, it } from "vitest";
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
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../src/config.js";
import { Engine } from "../src/engine.js";
import { State } from "../src/state.js";
import { makeWallets } from "../src/wallets.js";
import { compileFixtures } from "./fixtures/compile.js";

/**
 * Full pipeline against an in-process EVM: a crowd mints several collections,
 * then the engine (12 bot wallets, concurrent rounds, shared nonce manager)
 * must sweep the genuinely free ones and leave the rest alone.
 */
const BOTS = 12;
const CROWD = 8;

const chain = defineChain({
  id: 1337,
  name: "local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

const deployerKey = generatePrivateKey();
const crowdKeys = Array.from({ length: CROWD }, () => generatePrivateKey());
const botKeys = Array.from({ length: BOTS }, () => generatePrivateKey());

const provider = ganache.provider({
  logging: { quiet: true },
  chain: { chainId: 1337 },
  miner: { instamine: "strict" },
  wallet: {
    accounts: [deployerKey, ...crowdKeys, ...botKeys].map((secretKey) => ({
      secretKey,
      balance: toHex(parseEther("10")),
    })),
  },
});
const transport = custom(provider as never);
const publicClient = createPublicClient({ chain, transport, pollingInterval: 20 }) as PublicClient;

const artifacts = compileFixtures();
const addr: Record<string, Address> = {};
const bots = botKeys.map((k) => privateKeyToAccount(k).address);

async function deploy(name: string, key: Hex): Promise<Address> {
  const account = privateKeyToAccount(key);
  const wc = createWalletClient({ account, chain, transport });
  const { abi, bytecode } = artifacts[name];
  const hash = await wc.deployContract({ abi, bytecode, account, chain });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  return getAddress(r.contractAddress!);
}

async function crowdCall(name: string, fn: string, args: (who: Address) => unknown[], value = 0n) {
  for (const key of crowdKeys) {
    const account = privateKeyToAccount(key);
    const wc = createWalletClient({ account, chain, transport });
    const hash = await wc.writeContract({
      address: addr[name], abi: artifacts[name].abi as Abi, functionName: fn,
      args: args(account.address), value, account, chain,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
}

const ownerOf = (name: string, id: bigint) =>
  publicClient.readContract({ address: addr[name], abi: artifacts[name].abi as Abi, functionName: "ownerOf", args: [id] });

function makeEngine(env: Record<string, string> = {}) {
  const cfg = loadConfig({
    DRY_RUN: "false",
    PRIVATE_KEYS: botKeys.join(","),
    MIN_UNIQUE_MINTERS: "5",
    MIN_MINT_TXS: "5",
    MAX_GAS_COST_ETH: "0.01",
    TOTAL_GAS_BUDGET_ETH: "1",
    RECEIPT_TIMEOUT_MS: "10000",
    WALLET_CONCURRENCY: "6",
    ...env,
  });
  const state = new State(join(mkdtempSync(join(tmpdir(), "sweeper-e2e-")), "state.json"));
  const wallets = makeWallets(botKeys.map((k) => privateKeyToAccount(k)), chain, transport);
  return { engine: new Engine(publicClient, wallets, cfg, state), state, cfg };
}

const nonceOf = (a: Address) => publicClient.getTransactionCount({ address: a });

beforeAll(async () => {
  for (const n of ["FreeNFT", "ClaimNFT", "PaidNFT", "TrapNFT", "FakeNFT"]) addr[n] = await deploy(n, deployerKey);
  await crowdCall("FreeNFT", "mint", (who) => [who, 1n]);
  await crowdCall("ClaimNFT", "claim", () => []);
  await crowdCall("PaidNFT", "mint", () => [], parseEther("0.01"));
  await crowdCall("TrapNFT", "mint", () => []);
  await crowdCall("FakeNFT", "mint", () => []);
}, 180_000);

describe("engine end-to-end", () => {
  it("sweeps free mints with every wallet and avoids paid, trap and fake ones", async () => {
    const { engine, state } = makeEngine();
    await engine.init();
    await engine.tick();
    await engine.drain();

    for (const bot of bots) {
      const held = state.holdings(bot);
      const free = held.filter((h) => h.collection === addr.FreeNFT);
      const claim = held.filter((h) => h.collection === addr.ClaimNFT);
      expect(free).toHaveLength(1);
      expect(claim).toHaveLength(1);
      expect(held.some((h) => h.collection === addr.PaidNFT)).toBe(false);
      // The holdings recorded from receipts match on-chain ownership.
      expect(await ownerOf("FreeNFT", BigInt(free[0].tokenId))).toBe(bot);
      expect(await ownerOf("ClaimNFT", BigInt(claim[0].tokenId))).toBe(bot);
    }

    // Trap: exactly one scout tx was spent before the collection was blacklisted.
    expect(state.isBad(addr.TrapNFT)).toBe(true);
    expect(state.isBad(addr.FakeNFT)).toBe(true);
    const nonces = await Promise.all(bots.map(nonceOf));
    expect(nonces.reduce((a, b) => a + b, 0)).toBe(BOTS * 2 + 1);
    expect(state.gasSpent()).toBeGreaterThan(0n);

    // Another pass sends nothing: every wallet is at its per-collection limit.
    await engine.tick();
    await engine.drain();
    const after = await Promise.all(bots.map(nonceOf));
    expect(after).toEqual(nonces);
  }, 120_000);

  it("never sends in dry-run mode", async () => {
    const before = await Promise.all(bots.map(nonceOf));
    // New collection the bots have not minted yet.
    addr.FreeNFT2 = await deploy("FreeNFT", deployerKey);
    artifacts.FreeNFT2 = artifacts.FreeNFT;
    await crowdCall("FreeNFT2", "mint", (who) => [who, 1n]);
    const { engine } = makeEngine({ DRY_RUN: "true" });
    await engine.init();
    await engine.tick();
    await engine.drain();
    expect(await Promise.all(bots.map(nonceOf))).toEqual(before);
  }, 60_000);

  it("stops at the global gas budget", async () => {
    const before = await Promise.all(bots.map(nonceOf));
    // Budget fits roughly two worst-case mint txs.
    const fees = await publicClient.estimateFeesPerGas();
    const budget = (fees.maxFeePerGas * 120_000n * 25n) / 10n;
    const { engine } = makeEngine({ TOTAL_GAS_BUDGET_ETH: (Number(budget) / 1e18).toFixed(18) });
    await engine.init();
    await engine.tick();
    await engine.drain();
    const sent = (await Promise.all(bots.map(nonceOf))).reduce((a, n, i) => a + n - before[i], 0);
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(BOTS);
  }, 60_000);
});
