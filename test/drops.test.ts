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
import { decodeDrop, dropSignature, isArmable, mintCalldata, PUBLIC_DROP_UPDATED, type Drop } from "../src/drops.js";
import { Engine } from "../src/engine.js";
import { State } from "../src/state.js";
import { makeWallets } from "../src/wallets.js";
import { compileFixtures } from "./fixtures/compile.js";

const A = "0x00000000000000000000000000000000000000a1" as Address;
const drop = (over: Partial<Drop> = {}): Drop => ({
  nft: A, seaDrop: "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5", mintPrice: 0n, startTime: 2_000, endTime: 9_000,
  maxPerWallet: 5, feeBps: 1000, restrictFeeRecipients: true, block: 1n, ...over,
});

describe("drop announcements", () => {
  it("only arms free drops that are upcoming and sane", () => {
    const now = 1_000;
    expect(isArmable(drop(), now, 3600)).toBe(true);
    expect(isArmable(drop({ mintPrice: 1n }), now, 3600)).toBe(false); // never pays
    expect(isArmable(drop({ startTime: 1_000 + 7200 }), now, 3600)).toBe(false); // too far ahead
    expect(isArmable(drop({ startTime: 500, endTime: 900 }), now, 3600)).toBe(false); // already over
    expect(isArmable(drop({ startTime: 500, endTime: 5_000 }), now, 3600)).toBe(true); // already open
    expect(isArmable(drop({ endTime: 1_500, startTime: 1_600 }), now, 3600)).toBe(false); // ends before it starts
    expect(isArmable(drop({ maxPerWallet: 0 }), now, 3600)).toBe(false);
  });

  it("treats a re-announcement with the same terms as nothing new", () => {
    expect(dropSignature(drop())).toBe(dropSignature(drop({ block: 99n })));
    expect(dropSignature(drop())).not.toBe(dropSignature(drop({ startTime: 2_001 })));
  });

  it("builds mintPublic calldata that mints to the sender and respects the wallet limit", () => {
    const fee = "0x0000a26b00c1F0DF003000390027140000fAa719" as Address;
    const data = mintCalldata(drop({ maxPerWallet: 2 }), fee, 9);
    expect(data.slice(0, 10)).toBe("0x161ac21f"); // mintPublic(address,address,address,uint256)
    expect(BigInt(`0x${data.slice(-64)}`)).toBe(2n); // quantity capped at the drop's limit
    expect(data.slice(10 + 64 * 2, 10 + 64 * 3)).toBe("0".repeat(64)); // minterIfNotPayer = 0
  });

  it("ignores logs that are not well-formed announcements", () => {
    expect(decodeDrop({ address: A, topics: [PUBLIC_DROP_UPDATED], data: "0x", blockNumber: 1n })).toBeNull();
    expect(decodeDrop({ address: A, topics: [`0x${"11".repeat(32)}`, `0x${"0".repeat(64)}`], data: "0x", blockNumber: 1n })).toBeNull();
  });
});

// ── End to end: announce, wait, open, mint ─────────────────────────────────
const BOTS = 4;
const chain = defineChain({ id: 1337, name: "local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } });
const deployerKey = generatePrivateKey();
const botKeys = Array.from({ length: BOTS }, () => generatePrivateKey());
const provider = ganache.provider({
  logging: { quiet: true },
  chain: { chainId: 1337 },
  miner: { instamine: "strict" },
  wallet: { accounts: [deployerKey, ...botKeys].map((secretKey) => ({ secretKey, balance: toHex(parseEther("10")) })) },
});
const transport = custom(provider as never);
const client = createPublicClient({ chain, transport, pollingInterval: 20 }) as PublicClient;
const arts = compileFixtures();
const owner = privateKeyToAccount(deployerKey);
let seaDrop: Address;

const tx = async (fn: () => Promise<`0x${string}`>) => client.waitForTransactionReceipt({ hash: await fn() });
const ownerClient = () => createWalletClient({ account: owner, chain, transport });
async function deploy(name: string, args: unknown[] = []): Promise<Address> {
  const a = arts[name];
  const r = await tx(() => ownerClient().deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: owner, chain }));
  return getAddress(r.contractAddress!);
}
const chainNow = async () => Number((await client.getBlock()).timestamp);

beforeAll(async () => {
  seaDrop = await deploy("MiniSeaDrop");
}, 60_000);
afterAll(() => vi.restoreAllMocks());

function startEngine(extra: Record<string, string> = {}) {
  const cfg = loadConfig({
    DRY_RUN: "false", CHAIN_ID: "1337", MAX_BASE_FEE_GWEI: "off", PRIVATE_KEYS: botKeys.join(","), SEADROP_ADDRESS: seaDrop,
    MAX_GAS_COST_ETH: "0.01", TOTAL_GAS_BUDGET_ETH: "1", RECEIPT_TIMEOUT_MS: "10000", DROP_POLL_MS: "50", BACKFILL_BLOCKS: "0", ...extra,
  });
  const state = new State(join(mkdtempSync(join(tmpdir(), "drops-")), "state.json"));
  const wallets = makeWallets(botKeys.map((k) => privateKeyToAccount(k)), chain, transport);
  const engine = new Engine(client, wallets, cfg, state);
  return { engine, state, wallets };
}
const holdings = (state: State, wallets: ReturnType<typeof makeWallets>, nft: Address) =>
  wallets.map((w) => state.holdings(w.account.address).filter((h) => h.collection === nft).length);

describe("armed drops (end to end on a local chain)", () => {
  it("prepares ahead of time, sends nothing while the drop is closed, then mints for every wallet when it opens", async () => {
    const nft = await deploy("DropNFT", [seaDrop]);
    const { engine, state, wallets } = startEngine();
    const logs = vi.spyOn(console, "log");
    await engine.init();
    const mine = (a: Address) => client.getTransactionCount({ address: a });

    // The creator announces a free drop that opens a few seconds from now (chain time).
    const start = (await chainNow()) + 4;
    await tx(() => ownerClient().writeContract({ address: seaDrop, abi: arts.MiniSeaDrop.abi as Abi, functionName: "announce", args: [nft, 0n, start, start + 3600, 2], account: owner, chain }));
    await engine.tick(); // sees the announcement and arms
    expect(engine.session.armedDrops).toBe(1);
    // Preparing (fee recipient, safety checks) takes a few node round trips; wait for it to finish.
    for (let i = 0; i < 100 && !logs.mock.calls.flat().some((x) => String(x).includes("ARMED")); i++) await new Promise((r) => setTimeout(r, 50));
    expect(logs.mock.calls.flat().some((x) => String(x).includes("ARMED"))).toBe(true);
    for (const w of wallets) expect(await mine(w.account.address)).toBe(0); // nothing sent while it is closed

    // Let chain time pass the start. (ganache chain time follows the wall clock.)
    await new Promise((r) => setTimeout(r, 5500));
    await tx(() => ownerClient().sendTransaction({ to: owner.address, value: 0n, account: owner, chain })); // mine a block
    await engine.drain();
    for (let i = 0; i < 100 && holdings(state, wallets, nft).some((n) => n === 0); i++) await new Promise((r) => setTimeout(r, 100));

    expect(holdings(state, wallets, nft)).toEqual([1, 1, 1, 1]);
    expect(await client.readContract({ address: nft, abi: arts.DropNFT.abi as Abi, functionName: "totalSupply" })).toBe(BigInt(BOTS));
    for (const w of wallets) expect(await mine(w.account.address)).toBe(1); // exactly one transaction each
    logs.mockRestore();
  }, 90_000);

  it("never arms a paid drop", async () => {
    const nft = await deploy("DropNFT", [seaDrop]);
    const { engine } = startEngine();
    await engine.init();
    const start = (await chainNow()) + 5;
    await tx(() => ownerClient().writeContract({ address: seaDrop, abi: arts.MiniSeaDrop.abi as Abi, functionName: "announce", args: [nft, parseEther("0.01"), start, start + 3600, 2], account: owner, chain }));
    await engine.tick();
    expect(engine.session.armedDrops).toBe(0);
  }, 30_000);

  it("re-arms with the new terms when the creator changes the start time", async () => {
    const nft = await deploy("DropNFT", [seaDrop]);
    const { engine } = startEngine();
    await engine.init();
    const now = await chainNow();
    const announce = (start: number) => tx(() => ownerClient().writeContract({ address: seaDrop, abi: arts.MiniSeaDrop.abi as Abi, functionName: "announce", args: [nft, 0n, start, start + 3600, 2], account: owner, chain }));
    await announce(now + 600);
    await engine.tick();
    expect(engine.session.armedDrops).toBe(1);
    await announce(now + 600); // identical terms: ignored
    await engine.tick();
    expect(engine.session.armedDrops).toBe(1);
    await announce(now + 900); // changed: the old wait is cancelled and replaced
    await engine.tick();
    expect(engine.session.armedDrops).toBe(1);
    engine.stop();
  }, 30_000);

  it("does not chase announcements when DROPS is off", async () => {
    const nft = await deploy("DropNFT", [seaDrop]);
    const { engine } = startEngine({ DROPS: "false" });
    await engine.init();
    const start = (await chainNow()) + 5;
    await tx(() => ownerClient().writeContract({ address: seaDrop, abi: arts.MiniSeaDrop.abi as Abi, functionName: "announce", args: [nft, 0n, start, start + 3600, 2], account: owner, chain }));
    await engine.tick();
    expect(engine.session.armedDrops).toBe(0);
  }, 30_000);
});
