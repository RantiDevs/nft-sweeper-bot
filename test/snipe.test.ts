import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ganache from "ganache";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseEther,
  toFunctionSelector,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { calldataFor, checkPlan, prepare, settle, waitAndFire, type SnipeSettings, type SnipeTarget } from "../src/snipe.js";
import { State } from "../src/state.js";
import { makeWallets } from "../src/wallets.js";
import { compileFixtures } from "./fixtures/compile.js";

const WALLETS = 5;
const SUPPLY = 3;
const PORT = 20_000 + Math.floor(Math.random() * 20_000);
const URL = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 1337, name: "local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [URL] } } });

const deployerKey = generatePrivateKey();
const botKeys = Array.from({ length: WALLETS }, () => generatePrivateKey());
const server = ganache.server({
  logging: { quiet: true },
  chain: { chainId: 1337 },
  miner: { instamine: "strict" },
  wallet: { accounts: [deployerKey, ...botKeys].map((secretKey) => ({ secretKey, balance: toHex(parseEther("10")) })) },
});
const transport = http(URL);
const client = createPublicClient({ chain, transport, pollingInterval: 20 }) as PublicClient;
const deployer = privateKeyToAccount(deployerKey);
const art = compileFixtures().GatedNFT;
const wallets = makeWallets(botKeys.map((k) => privateKeyToAccount(k)), chain, transport);

const MINT = toFunctionSelector("mint(address)");
let nft: Address;

const settings = (over: Partial<SnipeSettings> = {}): SnipeSettings => ({
  gasLimit: 150_000n,
  maxFeePerGas: parseEther("0.000000005"),
  maxPriorityFeePerGas: 0n,
  chainId: 1337,
  maxGasCostWei: parseEther("0.01"),
  totalGasBudgetWei: parseEther("1"),
  allowPaid: false,
  ...over,
});
const target = (): SnipeTarget => ({ to: nft, data: `${MINT}{wallet}` as Hex, value: 0n });

beforeAll(async () => {
  await server.listen(PORT);
  const wc = createWalletClient({ account: deployer, chain, transport });
  const hash = await wc.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [BigInt(SUPPLY)], account: deployer, chain });
  nft = getAddress((await client.waitForTransactionReceipt({ hash })).contractAddress!);
}, 60_000);

afterAll(async () => {
  await server.close();
});

describe("snipe: plan checks", () => {
  it("substitutes each wallet's address into the calldata", () => {
    const a = wallets[0].account.address;
    expect(calldataFor(target(), a)).toBe(`${MINT}${a.slice(2).toLowerCase().padStart(64, "0")}`);
    const copied = calldataFor({ to: nft, data: `${MINT}${"0".repeat(24)}${"11".repeat(20)}` as Hex, copiedFrom: "0x1111111111111111111111111111111111111111", value: 0n }, a);
    expect(copied).toContain(a.slice(2).toLowerCase());
    expect(copied).not.toContain("1".repeat(40));
  });

  it("refuses approvals, paid mints and anything over the gas caps", () => {
    expect(() => checkPlan({ to: nft, data: "0xa22cb465" + "0".repeat(128) as Hex, value: 0n }, settings(), 1)).toThrow(/approval\/transfer/);
    expect(() => checkPlan({ ...target(), value: 1n }, settings(), 1)).toThrow(/sends ETH/);
    expect(checkPlan({ ...target(), value: 1n }, settings({ allowPaid: true }), 1)).toBeGreaterThan(0n);
    expect(() => checkPlan(target(), settings({ maxGasCostWei: 1n }), 1)).toThrow(/MAX_GAS_COST_ETH/);
    expect(() => checkPlan(target(), settings({ totalGasBudgetWei: 1n }), 5)).toThrow(/TOTAL_GAS_BUDGET_ETH/);
  });

  it("refuses a wallet that cannot cover the worst case", async () => {
    const poor = makeWallets([privateKeyToAccount(generatePrivateKey())], chain, transport);
    await expect(prepare(client, poor, target(), settings())).rejects.toThrow(/needs about/);
  });
});

describe("snipe: limited first-come-first-served drop", () => {
  it("sends nothing while closed, then fires every signed transaction right after it opens", async () => {
    const prepared = await prepare(client, wallets, target(), settings());
    expect(prepared).toHaveLength(WALLETS);
    expect(prepared.every((p) => p.raw.startsWith("0x02"))).toBe(true); // EIP-1559, signed in advance

    const probe = wallets[0].account.address;
    const isOpen = () => client.call({ account: probe, to: nft, data: calldataFor(target(), probe) }).then(() => true, () => false);
    expect(await isOpen()).toBe(false);

    const run = waitAndFire(prepared, { urls: [URL], pollMs: 10, maxWaitMs: 30_000, isOpen });
    await new Promise((r) => setTimeout(r, 400));
    for (const w of wallets) expect(await client.getTransactionCount({ address: w.account.address })).toBe(0); // nothing sent while closed

    const owner = createWalletClient({ account: deployer, chain, transport });
    await client.waitForTransactionReceipt({ hash: await owner.writeContract({ address: nft, abi: art.abi as Abi, functionName: "setOpen", args: [true], account: deployer, chain }) });

    const result = await run;
    expect(result.opened).toBe(true);
    expect(result.sentAt! - result.openedAt!).toBeLessThan(500);
    expect(Object.keys(result.hashes)).toHaveLength(WALLETS);
    expect(result.checks).toBeGreaterThan(5);

    const state = new State(join(mkdtempSync(join(tmpdir(), "snipe-")), "state.json"));
    const outcome = await settle(client, prepared, result.hashes, state);
    // Supply is 3: exactly three wallets get a token, the rest revert (and lose only gas).
    expect(outcome.filter((o) => o.ok)).toHaveLength(SUPPLY);
    expect(outcome.filter((o) => !o.ok && /reverted/.test(o.note ?? ""))).toHaveLength(WALLETS - SUPPLY);
    expect(await client.readContract({ address: nft, abi: art.abi as Abi, functionName: "totalSupply" })).toBe(BigInt(SUPPLY));
    const held = wallets.reduce((a, w) => a + state.holdings(w.account.address).length, 0);
    expect(held).toBe(SUPPLY);
    expect(state.gasSpent()).toBeGreaterThan(0n);
  }, 60_000);

  it("gives up cleanly if the mint never opens, and honours --not-before", async () => {
    const prepared = await prepare(client, wallets.slice(0, 1), target(), settings());
    const never = await waitAndFire(prepared, { urls: [URL], pollMs: 10, maxWaitMs: 300, isOpen: async () => false });
    expect(never.opened).toBe(false);
    expect(Object.keys(never.hashes)).toHaveLength(0);

    const t0 = Date.now();
    const late = await waitAndFire(prepared, { urls: [URL], pollMs: 10, maxWaitMs: 5000, notBefore: t0 + 600, isOpen: async () => true });
    expect(late.openedAt! - t0).toBeGreaterThanOrEqual(550); // the check passed instantly, but it waited for the start time
  }, 30_000);

  it("sends to every endpoint and tolerates one of them failing", async () => {
    const prepared = await prepare(client, wallets.slice(0, 2), target(), settings());
    const seen: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push(String(url));
      if (String(url).includes("down")) throw new Error("connection refused");
      const batch = JSON.parse(String(init?.body));
      if (Array.isArray(batch) && batch[0].method === "eth_sendRawTransaction") {
        return { ok: true, status: 200, json: async () => batch.map((r: { id: number }) => ({ jsonrpc: "2.0", id: r.id, result: `0x${String(r.id).padStart(64, "a")}` })) };
      }
      return { ok: true, status: 200, json: async () => ({ result: "0x1" }) };
    }) as unknown as typeof fetch;
    const r = await waitAndFire(prepared, { urls: ["http://good.example", "http://down.example"], pollMs: 5, maxWaitMs: 2000, isOpen: async () => true, fetchFn });
    expect(Object.keys(r.hashes)).toHaveLength(2);
    expect(r.errors.some((e) => /endpoint 2/.test(e))).toBe(true);
    expect(seen.filter((u) => u.includes("good")).length).toBeGreaterThanOrEqual(2); // warm-up + the real send
  });
});
