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
import { analyzeHoldings, heldTokens } from "../src/rarity/analyze.js";
import { planCsv, DEFAULT_TIERS } from "../src/rarity/plan.js";
import { DEFAULT_VALUATION } from "../src/market/valuation.js";
import { State } from "../src/state.js";
import { makeWallets } from "../src/wallets.js";
import { compileFixtures } from "./fixtures/compile.js";

/**
 * A 100-token collection with on-chain traits. A bot wallet mints all 100, then 40 different
 * buyers purchase common tokens at rising prices. The pipeline must read the traits, the sales
 * and the holders, and decide what to hold and what to sell.
 */
const BUYERS = 40;
const chain = defineChain({ id: 1337, name: "local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } });
const holderKey = generatePrivateKey();
const buyerKeys = Array.from({ length: BUYERS }, () => generatePrivateKey());
const provider = ganache.provider({
  logging: { quiet: true },
  chain: { chainId: 1337 },
  miner: { instamine: "strict" },
  wallet: { accounts: [holderKey, ...buyerKeys].map((secretKey) => ({ secretKey, balance: toHex(parseEther("100")) })) },
});
const transport = custom(provider as never);
const publicClient = createPublicClient({ chain, transport, pollingInterval: 20 }) as PublicClient;
const art = compileFixtures().TraitNFT;
const holder = privateKeyToAccount(holderKey);

let collection: Address;
let mintTx: Hex;
const isCommon = (id: number) => id % 3 !== 0 && id % 10 !== 0 && id % 25 !== 0;
const common = Array.from({ length: 100 }, (_, i) => i + 1).filter(isCommon);

beforeAll(async () => {
  const wc = createWalletClient({ account: holder, chain, transport });
  const dep = await wc.deployContract({ abi: art.abi, bytecode: art.bytecode, account: holder, chain });
  collection = getAddress((await publicClient.waitForTransactionReceipt({ hash: dep })).contractAddress!);
  mintTx = await wc.writeContract({ address: collection, abi: art.abi as Abi, functionName: "mint", args: [holder.address, 100n], account: holder, chain });
  await publicClient.waitForTransactionReceipt({ hash: mintTx });

  // 40 different buyers: send in parallel batches of 10 so the chain is busy but not flooded.
  for (let start = 0; start < BUYERS; start += 10) {
    await Promise.all(
      Array.from({ length: Math.min(10, BUYERS - start) }, async (_, j) => {
        const i = start + j;
        const buyer = privateKeyToAccount(buyerKeys[i]);
        const bw = createWalletClient({ account: buyer, chain, transport });
        const hash = await bw.writeContract({
          address: collection, abi: art.abi as Abi, functionName: "buy", args: [BigInt(common[i])],
          value: parseEther((0.01 + i * 0.0002).toFixed(4)), account: buyer, chain,
        });
        await publicClient.waitForTransactionReceipt({ hash });
      }),
    );
  }
}, 180_000);

describe("rarity + market pipeline", () => {
  it("holds the rarest tokens, sells common ones near the floor, and explains why", async () => {
    const state = new State(join(mkdtempSync(join(tmpdir(), "plan-")), "state.json"));
    const mine = [100, 50, 20, 7, 8];
    state.recordMint(collection, holder.address, mine.map((id) => ({ collection, standard: "erc721" as const, tokenId: String(id), amount: "1", tx: mintTx })));
    const wallets = makeWallets([holder], chain, transport);

    const plan = await analyzeHoldings(
      publicClient,
      heldTokens(wallets, state),
      { sample: 500, concurrency: 8, cacheDir: join(mkdtempSync(join(tmpdir(), "meta-")), "m") },
      { tiers: DEFAULT_TIERS, feePct: 5, ethUsd: 3000, gasSpentWei: 10n ** 15n, mode: "auto", valuation: DEFAULT_VALUATION },
      undefined,
      { valuation: DEFAULT_VALUATION, blocksPerHour: 36_000 },
    );

    const row = (id: number) => plan.rows.find((r) => r.tokenId === String(id))!;
    // Gold + Crown: the two rarest tokens in the collection.
    expect(row(100).rank).toBe(1);
    expect(row(100).percentile!).toBeLessThan(0.01); // tied with token 50 for first place
    expect(row(100).action).toBe("HOLD");
    expect(row(50).action).toBe("HOLD");
    expect(row(20).action).toBe("HOLD"); // Gold: top ~4%
    // Blue/None is the most common combination.
    expect(row(7).action).toBe("SELL");
    expect(row(7).percentile!).toBeGreaterThan(0.6); // the huge tie of most-common tokens ranks at its middle

    // Common tokens are listed at about the floor (~0.0108 ETH x $3000); rare ones are worth much more.
    expect(row(7).listEth!).toBeGreaterThan(0.009);
    expect(row(7).listEth!).toBeLessThan(0.0125);
    expect(row(100).valueEth!).toBeGreaterThan(row(7).valueEth! * 3);
    expect(row(7).note).toMatch(/active market/);
    expect(row(100).note).toMatch(/rarity top/);

    // Money maths.
    expect(plan.hold).toBe(3);
    expect(plan.byTier.find((t) => t.label === "SELL")!.count).toBe(2);
    expect(plan.holdValueUsd!).toBeGreaterThan(100);
    expect(plan.gasSpentUsd).toBeCloseTo(3);
    expect(plan.proceedsUsd).toBeCloseTo(plan.listUsd * 0.95);

    const csv = planCsv(plan.rows);
    expect(csv.split("\n")[0]).toContain("value_usd");
    expect(csv).toContain("HOLD");
  }, 180_000);

  it("reports no market for a collection nobody has traded", async () => {
    const wc = createWalletClient({ account: holder, chain, transport });
    const dep = await wc.deployContract({ abi: art.abi, bytecode: art.bytecode, account: holder, chain });
    const quiet = getAddress((await publicClient.waitForTransactionReceipt({ hash: dep })).contractAddress!);
    const tx = await wc.writeContract({ address: quiet, abi: art.abi as Abi, functionName: "mint", args: [holder.address, 10n], account: holder, chain });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    const state = new State(join(mkdtempSync(join(tmpdir(), "plan-")), "state.json"));
    state.recordMint(quiet, holder.address, [{ collection: quiet, standard: "erc721", tokenId: "10", amount: "1", tx }]);
    const plan = await analyzeHoldings(
      publicClient,
      heldTokens(makeWallets([holder], chain, transport), state),
      { sample: 100, concurrency: 4 },
      { tiers: DEFAULT_TIERS, feePct: 5, ethUsd: 3000, gasSpentWei: 0n, mode: "auto", valuation: DEFAULT_VALUATION },
    );
    expect(plan.rows[0].action).toBe("WAIT");
    expect(plan.rows[0].note).toMatch(/no sales or listings yet/);
  }, 120_000);

  it("tiers mode still uses the fixed price tiers", async () => {
    const state = new State(join(mkdtempSync(join(tmpdir(), "plan-")), "state.json"));
    state.recordMint(collection, holder.address, [100, 7].map((id) => ({ collection, standard: "erc721" as const, tokenId: String(id), amount: "1", tx: mintTx })));
    const plan = await analyzeHoldings(
      publicClient,
      heldTokens(makeWallets([holder], chain, transport), state),
      { sample: 500, concurrency: 8 },
      { tiers: DEFAULT_TIERS, feePct: 5, ethUsd: 3000, gasSpentWei: 0n, mode: "tiers" },
    );
    expect(plan.rows.map((r) => [r.tokenId, r.action, r.priceUsd])).toEqual([["100", "HOLD", undefined], ["7", "SELL", 5]]);
  }, 120_000);
});
