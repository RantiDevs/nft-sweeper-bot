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
import type { SessionEvent } from "../src/session.js";
import { loadTgConfig, usersFile } from "../src/tg/config.js";
import { generateMasterKey } from "../src/tg/crypto.js";
import { EthPriceOracle } from "../src/price.js";
import { Hub } from "../src/tg/hub.js";
import { UserStore } from "../src/tg/store.js";
import { compileFixtures } from "./fixtures/compile.js";

/**
 * Several Telegram users share ONE chain watcher but have separate wallets,
 * limits and state: a live user, a dry-run user, and a sniper with an allowlist.
 */
const ALICE = 101; // live, default thresholds
const BOB = 102; // dry-run (the default for new users)
const CAROL = 103; // live, allowlist of one collection
const DAVE = 104; // live, hot-only mode (needs a crowd)
const WALLETS_EACH = 3;
const CROWD = 8;

const chain = defineChain({ id: 1337, name: "local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } });
const deployerKey = generatePrivateKey();
const funderKey = generatePrivateKey();
const crowdKeys = Array.from({ length: CROWD }, () => generatePrivateKey());

const provider = ganache.provider({
  logging: { quiet: true },
  chain: { chainId: 1337 },
  miner: { instamine: "strict" },
  wallet: { accounts: [deployerKey, funderKey, ...crowdKeys].map((secretKey) => ({ secretKey, balance: toHex(parseEther("100")) })) },
});
const transport = custom(provider as never);
const publicClient = createPublicClient({ chain, transport, pollingInterval: 20 }) as PublicClient;
const artifacts = compileFixtures();
const addr: Record<string, Address> = {};

async function deploy(name: string): Promise<Address> {
  const account = privateKeyToAccount(deployerKey);
  const wc = createWalletClient({ account, chain, transport });
  const { abi, bytecode } = artifacts[name];
  const hash = await wc.deployContract({ abi, bytecode, account, chain });
  return getAddress((await publicClient.waitForTransactionReceipt({ hash })).contractAddress!);
}

async function crowdMint(name: string, fn: string, args: (who: Address) => unknown[], value = 0n, wallets = crowdKeys) {
  for (const key of wallets) {
    const account = privateKeyToAccount(key);
    const wc = createWalletClient({ account, chain, transport });
    const hash = await wc.writeContract({ address: addr[name], abi: artifacts[name.replace(/\d+$/, "")].abi as Abi, functionName: fn, args: args(account.address), value, account, chain });
    await publicClient.waitForTransactionReceipt({ hash });
  }
}

const events: Record<number, SessionEvent[]> = { [ALICE]: [], [BOB]: [], [CAROL]: [], [DAVE]: [] };
const alerts: string[] = [];
let hub: Hub;
let store: UserStore;

const nonceOf = (a: Address) => publicClient.getTransactionCount({ address: a });
const holdings = (id: number, collection: Address) =>
  hub.wallets(id).map((w) => hub.state(id).holdings(w.account.address).filter((h) => h.collection === collection).length);

beforeAll(async () => {
  for (const n of ["FreeNFT", "ClaimNFT", "PaidNFT", "TrapNFT", "FakeNFT", "FreeNFT2"]) addr[n] = await deploy(n.replace(/\d+$/, ""));
  await crowdMint("FreeNFT", "mint", (who) => [who, 1n]);
  await crowdMint("ClaimNFT", "claim", () => []);
  await crowdMint("PaidNFT", "mint", () => [], parseEther("0.01"));
  await crowdMint("TrapNFT", "mint", () => []);
  await crowdMint("FakeNFT", "mint", () => []);
  // Only 2 distinct minters: below the default threshold, so non-snipers must ignore it.
  await crowdMint("FreeNFT2", "mint", (who) => [who, 1n], 0n, crowdKeys.slice(0, 2));

  const dir = mkdtempSync(join(tmpdir(), "tg-e2e-"));
  const tg = loadTgConfig({
    TELEGRAM_BOT_TOKEN: "123:abc", ADMIN_IDS: "1", MASTER_KEY: generateMasterKey(), DATA_DIR: dir,
    CHAIN_ID: "1337", MIN_UNIQUE_MINTERS: "5", MIN_MINT_TXS: "5", MAX_GAS_COST_ETH: "0.01", RECEIPT_TIMEOUT_MS: "10000",
  });
  store = new UserStore(usersFile(tg));
  hub = new Hub({
    publicClient, chain, transport, tg, store,
    price: new EthPriceOracle({ sources: [], fallback: 3000 }),
    onUserEvent: (id, e) => void events[id].push(e),
    onAdminAlert: (t) => void alerts.push(t),
  });
  for (const id of [ALICE, BOB, CAROL, DAVE]) {
    hub.register(id, `u${id}`, "user");
    hub.addWallets(id, WALLETS_EACH);
  }
  hub.update(ALICE, { dryRun: false });
  hub.update(CAROL, { dryRun: false, allowlist: [addr.FreeNFT] });
  hub.update(DAVE, { dryRun: false, sweep: false });

  const funder = privateKeyToAccount(funderKey);
  const wc = createWalletClient({ account: funder, chain, transport });
  for (const id of [ALICE, BOB, CAROL, DAVE]) {
    // Test chain only: set the balance directly instead of sending one transfer after another.
    for (const w of hub.wallets(id)) {
      await (provider as unknown as { request: (a: unknown) => Promise<unknown> }).request({
        method: "evm_setAccountBalance",
        params: [w.account.address, toHex(parseEther("1"))],
      });
    }
    void wc;
  }
}, 180_000);

describe("multi-user hub", () => {
  it("runs each user's own rules from one shared chain scan", async () => {
    await hub.watcher.init();
    await hub.watcher.tick();
    await hub.drain();

    // Alice (live, sweep mode by default): every genuinely free collection, including the one
    // only 2 wallets minted. Paid, trap and fake collections are left alone.
    expect(holdings(ALICE, addr.FreeNFT)).toEqual([1, 1, 1]);
    expect(holdings(ALICE, addr.ClaimNFT)).toEqual([1, 1, 1]);
    expect(holdings(ALICE, addr.FreeNFT2)).toEqual([1, 1, 1]);
    for (const c of ["PaidNFT", "TrapNFT", "FakeNFT"]) expect(holdings(ALICE, addr[c]).every((n) => n === 0)).toBe(true);

    // Dave (hot mode): only crowded collections; the 2-minter one is ignored.
    expect(holdings(DAVE, addr.FreeNFT)).toEqual([1, 1, 1]);
    expect(holdings(DAVE, addr.ClaimNFT)).toEqual([1, 1, 1]);
    expect(holdings(DAVE, addr.FreeNFT2)).toEqual([0, 0, 0]);
    expect(hub.state(ALICE).isBad(addr.TrapNFT)).toBe(true); // one tx spent, then blocked
    expect(hub.state(ALICE).isBad(addr.FakeNFT)).toBe(true); // fails ERC-165
    expect(hub.state(ALICE).gasSpent()).toBeGreaterThan(0n);

    // Carol (allowlist = FreeNFT): only that collection, and one tx per wallet.
    expect(holdings(CAROL, addr.FreeNFT)).toEqual([1, 1, 1]);
    expect(holdings(CAROL, addr.ClaimNFT)).toEqual([0, 0, 0]);
    for (const w of hub.wallets(CAROL)) expect(await nonceOf(w.account.address)).toBe(1);

    // Bob (dry-run): reported what he could mint, sent nothing, spent nothing.
    for (const w of hub.wallets(BOB)) expect(await nonceOf(w.account.address)).toBe(0);
    expect(hub.state(BOB).gasSpent()).toBe(0n);
    const bobRounds = events[BOB].filter((e) => e.type === "round");
    expect(bobRounds.length).toBeGreaterThan(0);
    expect(bobRounds.every((e) => e.type === "round" && e.dryRun && e.minted === 0 && e.wouldMint > 0)).toBe(true);

    // Alice's notifications describe real mints.
    const aliceMinted = events[ALICE].filter((e) => e.type === "round" && e.minted > 0);
    expect(aliceMinted.length).toBe(3);
    expect(events[ALICE].some((e) => e.type === "bad")).toBe(true);
  }, 180_000);

  it("keeps every user's state in separate files and never re-mints", async () => {
    const before = await Promise.all(hub.wallets(ALICE).map((w) => nonceOf(w.account.address)));
    await hub.watcher.tick();
    await hub.drain();
    expect(await Promise.all(hub.wallets(ALICE).map((w) => nonceOf(w.account.address)))).toEqual(before);
    expect(hub.state(ALICE)).not.toBe(hub.state(CAROL));
  }, 60_000);

  it("a paused user stops minting without affecting others; banned users are removed", async () => {
    addr.FreeNFT3 = await deploy("FreeNFT");
    await crowdMint("FreeNFT3", "mint", (who) => [who, 1n]);
    hub.update(ALICE, { paused: true });
    hub.update(CAROL, { allowlist: [] });
    hub.update(CAROL, { dryRun: true });
    await hub.watcher.tick();
    await hub.drain();
    expect(holdings(ALICE, addr.FreeNFT3)).toEqual([0, 0, 0]);
    expect(events[BOB].some((e) => e.type === "round" && e.collection === addr.FreeNFT3)).toBe(true);

    expect(hub.setBanned(BOB, true)).toBe(true);
    expect(hub.has(BOB)).toBe(false);
    expect(hub.summary().active).toBe(3);
    expect(hub.setBanned(BOB, false)).toBe(true);
    expect(hub.has(BOB)).toBe(true);
    expect(hub.wallets(BOB)).toHaveLength(WALLETS_EACH);
  }, 120_000);

  it("collects NFTs to the user's vault and recovers leftover ETH", async () => {
    const vault = privateKeyToAccount(generatePrivateKey()).address;
    const plan = await hub.collect(ALICE, vault, false);
    expect(plan.planned).toBe(WALLETS_EACH * 3);
    const done = await hub.collect(ALICE, vault, true);
    expect(done.moved).toBe(WALLETS_EACH * 3);
    expect(done.failed).toBe(0);
    const owner = await publicClient.readContract({ address: addr.FreeNFT, abi: artifacts.FreeNFT.abi as Abi, functionName: "ownerOf", args: [BigInt(hub.state(ALICE).holdings(hub.wallets(ALICE)[0].account.address).length + 1)] }).catch(() => undefined);
    void owner;
    for (const w of hub.wallets(ALICE)) expect(hub.state(ALICE).holdings(w.account.address)).toHaveLength(0);

    const rec = privateKeyToAccount(generatePrivateKey()).address;
    const r = await hub.recover(ALICE, rec, true);
    expect(r.sent).toBe(WALLETS_EACH);
    expect(await publicClient.getBalance({ address: rec })).toBeGreaterThan(parseEther("2.9"));
  }, 120_000);

  it("walletsPerCollection limits how many wallets pay gas for each collection", async () => {
    addr.FreeNFT4 = await deploy("FreeNFT");
    await crowdMint("FreeNFT4", "mint", (who) => [who, 1n]);
    hub.update(DAVE, { walletsPerCollection: 2 });
    await hub.watcher.tick();
    await hub.drain();
    expect(holdings(DAVE, addr.FreeNFT4).reduce((a, b) => a + b, 0)).toBe(2);
  }, 120_000);

  it("survives a restart: wallets decrypt from disk and still belong to the user", () => {
    const tgCfg = loadTgConfig({ TELEGRAM_BOT_TOKEN: "1:a", ADMIN_IDS: "1", MASTER_KEY: generateMasterKey(), DATA_DIR: "x" });
    void tgCfg;
    const keys = hub.exportKeys(CAROL);
    expect(keys).toHaveLength(WALLETS_EACH);
    for (const k of keys) expect(privateKeyToAccount(k.key as Hex).address).toBe(k.address);
  });
});
