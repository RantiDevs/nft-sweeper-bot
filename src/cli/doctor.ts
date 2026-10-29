import { formatUnits, type Address, type PublicClient } from "viem";
import { loadConfig } from "../config.js";
import { FeeOracle } from "../fees.js";
import { Watcher } from "../watcher.js";
import { OpenSeaClient } from "../market/opensea.js";
import { fmtUsd, fmtWei } from "../money.js";
import { EthPriceOracle } from "../price.js";
import { assertChain, makeClients } from "../rpc.js";
import { sleep } from "../util.js";
import { loadAccounts } from "../wallets.js";
import { parseMintLog } from "../logs.js";

// Read-only health check against the real chain. Sends nothing and spends nothing.
// Usage: npm run doctor

type Result = "ok" | "warn" | "fail";
const mark: Record<Result, string> = { ok: "[ OK ]", warn: "[WARN]", fail: "[FAIL]" };
const line = (r: Result, text: string) => console.log(`${mark[r]} ${text}`);
const errText = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

async function probe(client: PublicClient, method: string, params: unknown[]): Promise<"supported" | "unsupported" | "error"> {
  try {
    await client.request({ method: method as never, params: params as never });
    return "supported";
  } catch (e) {
    return /not found|not supported|unsupported|disabled|not available|does not exist|method/i.test(errText(e)) ? "unsupported" : "error";
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.env, { requireWallets: false });
  const { chain, publicClient } = makeClients(cfg);
  console.log(`Checking ${chain.name} (${cfg.chainId}) via ${cfg.rpcUrls[0] ?? "the default public RPC"}\n`);

  // 1. RPC and chain
  let t = Date.now();
  try {
    await assertChain(publicClient, cfg.chainId);
    line("ok", `RPC answers and is chain ${cfg.chainId} (${Date.now() - t} ms)`);
  } catch (e) {
    line("fail", `RPC: ${errText(e)}. Nothing else can be checked.`);
    return;
  }
  if (cfg.rpcUrls.length === 0) line("warn", "Using the public RPC: it is rate limited. A paid RPC (RPC_URLS) is faster and safer for racing mints.");

  // 2. Block rate
  const b1 = await publicClient.getBlock();
  await sleep(3000);
  const b2 = await publicClient.getBlock();
  const perSec = Number(b2.number - b1.number) / Math.max(1, Number(b2.timestamp - b1.timestamp) || 3);
  line("ok", `block ${b2.number}, about ${perSec.toFixed(1)} blocks/second (WINDOW_BLOCKS=${cfg.windowBlocks} covers ~${Math.round(cfg.windowBlocks / Math.max(perSec, 0.1) / 60)} min)`);

  // 3. Price and fees
  const px = await new EthPriceOracle({ fallback: process.env.ETH_USD ? Number(process.env.ETH_USD) : undefined }).get();
  line(px ? "ok" : "warn", px ? `ETH price $${px.toLocaleString("en-US")} (live feeds)` : "ETH price unavailable: amounts will show in ETH only");
  const base = b2.baseFeePerGas ?? 0n;
  const gwei = Number(formatUnits(base, 9));
  line(
    cfg.maxBaseFeeWei !== undefined && base > cfg.maxBaseFeeWei ? "warn" : "ok",
    `base fee ${gwei.toFixed(4)} gwei` +
      (cfg.maxBaseFeeWei !== undefined
        ? base > cfg.maxBaseFeeWei ? `, ABOVE your MAX_BASE_FEE_GWEI cap (${formatUnits(cfg.maxBaseFeeWei, 9)}): the bot would wait` : ` (cap ${formatUnits(cfg.maxBaseFeeWei, 9)} gwei not hit)`
        : ""),
  );

  // What a mint costs right now, measured. The data-posting part (L1) dominates and swings ~100x.
  try {
    const oracle = new FeeOracle(publicClient, { multiplier: cfg.baseFeeMultiplier, minPriorityFeeWei: cfg.priorityFeeWei });
    const { gas, costWei } = await oracle.mintCost(publicClient);
    const over = costWei > cfg.maxGasCostWei;
    line(
      over ? "warn" : "ok",
      `a typical mint costs ${fmtWei(costWei, px, 7)} right now (${gas.toString()} gas, mostly the cost of posting data to Ethereum)` +
        (over ? `: ABOVE your per-mint cap of ${fmtWei(cfg.maxGasCostWei, px, 7)}, so the bot waits for cheaper gas` : `: within your per-mint cap of ${fmtWei(cfg.maxGasCostWei, px, 7)}`),
    );
    if (px && costWei > 0n) {
      const budgetMints = Math.floor(Number(cfg.totalGasBudgetWei) / Number(costWei));
      line("ok", `at this price your total budget of ${fmtWei(cfg.totalGasBudgetWei, px, 7)} pays for about ${budgetMints} mint(s); this cost has swung about 100x within an hour`);
    }
  } catch (e) {
    line("warn", `could not measure the cost of a mint: ${errText(e)}`);
  }

  // 4. What the RPC supports
  const sim = await probe(publicClient, "eth_simulateV1", [{ blockStateCalls: [{ calls: [{ to: "0x0000000000000000000000000000000000000001", data: "0x" }] }] }, "latest"]);
  line(sim === "supported" ? "ok" : "warn", sim === "supported" ? "eth_simulateV1 works: trap mints can be rejected for free" : "eth_simulateV1 not available on this RPC: trap mints will cost one scout transaction");
  const trace = await probe(publicClient, "debug_traceCall", [{ to: "0x0000000000000000000000000000000000000001", data: "0x" }, "latest", { tracer: "callTracer" }]);
  line(trace === "supported" ? "ok" : "warn", trace === "supported" ? "debug_traceCall works: the mint trace screen is active" : "debug_traceCall not available: the trace screen is skipped (other checks still run)");

  // 5. Real mint activity: scan the window like the bot does
  const watcher = new Watcher(publicClient, { windowBlocks: cfg.windowBlocks, pollIntervalMs: 1000, vet: { requireVerified: false, trace: false } });
  // The watcher only records collections someone wants; stand in for a user who wants all of them.
  watcher.subscribe({ wants: () => true, owns: () => false, floor: () => ({ minUniqueMinters: 1, minMintTxs: 1 }), offer: () => {} });
  t = Date.now();
  try {
    await watcher.init();
    await watcher.tick();
    const free = watcher.detector.hot({ minUniqueMinters: 1, minMintTxs: 1 });
    const crowded = watcher.detector.hot({ minUniqueMinters: cfg.minUniqueMinters, minMintTxs: cfg.minMintTxs });
    line("ok", `scanned ${cfg.windowBlocks} blocks in ${Date.now() - t} ms: ${free.length} collection(s) with only free mints, ${crowded.length} crowded enough for hot mode`);
    for (const h of free.slice(0, 5)) {
      console.log(`        ${h.collection}  ${h.uniqueMinters} wallets / ${h.mintTxs} txs  via ${h.templates[0].input.slice(0, 10)}`);
    }

    // What is minting? Count NFT mint events by type and sample the paying transactions, so a
    // result of "0 free collections" can be told apart from "the scan is missing things".
    const head = watcher.currentHead;
    const raw = await watcher.fetchMintLogs(head - BigInt(cfg.windowBlocks), head);
    const byCollection = new Map<string, { n: number; standard: string; tx: string }>();
    for (const l of raw) {
      const m = parseMintLog(l);
      if (!m) continue;
      const cur = byCollection.get(m.collection);
      byCollection.set(m.collection, { n: (cur?.n ?? 0) + 1, standard: m.standard, tx: l.transactionHash });
    }
    const top = [...byCollection].sort((a, b) => b[1].n - a[1].n).slice(0, 12);
    let sampledFree = 0, paid = 0, errors = 0;
    const sampleRows: string[] = [];
    for (const [c, info] of top) {
      try {
        const tx = await publicClient.getTransaction({ hash: info.tx as `0x${string}` });
        if (tx.value > 0n) paid++; else sampledFree++;
        sampleRows.push(`        ${c}  ${info.n} mint events (${info.standard})  sample tx ${tx.value > 0n ? "PAID " + fmtWei(tx.value, px) : "free"}`);
      } catch {
        errors++;
      }
      await sleep(150);
    }
    line("ok", `${raw.length} mint-shaped events -> ${byCollection.size} NFT collection(s) minting in this window; of the ${top.length} busiest, ${sampledFree} sampled free, ${paid} paid${errors ? `, ${errors} lookups failed` : ""}`);
    sampleRows.forEach((r) => console.log(r));

    // 6. OpenSea
    if (process.env.OPENSEA_API_KEY) {
      const os = new OpenSeaClient({ apiKey: process.env.OPENSEA_API_KEY, chainSlug: cfg.chainId === 4663 ? process.env.OPENSEA_CHAIN : undefined });
      const slug = await os.discoverChain();
      if (!slug) line("warn", "OpenSea key set, but no Robinhood chain found in OpenSea's chain list (key invalid or chain not listed). Prices will come from on-chain sales only.");
      else {
        line("ok", `OpenSea key works; chain slug "${slug}"`);
        for (const h of free.slice(0, 3)) {
          const s = await os.stats(h.collection as Address);
          console.log(`        ${h.collection}: ${s ? `floor ${s.floorEth ?? "none"} ETH${s.floorEth && px ? ` (${fmtUsd(s.floorEth * px)})` : ""}, owners ${s.owners ?? "?"}` : "not on OpenSea yet"}`);
        }
      }
    } else {
      line("warn", "OPENSEA_API_KEY is not set (checked process env / .env). Prices will come from on-chain sales only.");
    }
  } catch (e) {
    line("fail", `scan failed: ${errText(e)}`);
  }

  // 7. Wallets
  try {
    const accounts = loadAccounts(cfg);
    if (accounts.length === 0) line("warn", "no wallets configured (KEYS_FILE / PRIVATE_KEYS / MNEMONIC): fine for dry-run watching");
    else {
      const bals = await Promise.all(accounts.map((a) => publicClient.getBalance({ address: a.address })));
      const total = bals.reduce((a, b) => a + b, 0n);
      const low = bals.filter((b) => b < cfg.maxGasCostWei).length;
      line(low ? "warn" : "ok", `${accounts.length} wallet(s), ${fmtWei(total, px)} total${low ? `, ${low} below one max-cost transaction` : ""}`);
    }
  } catch (e) {
    line("fail", `wallets: ${errText(e)}`);
  }

  console.log(`\nMode: ${cfg.dryRun ? "DRY RUN (nothing will be sent)" : "LIVE"}. Per-tx cap ${fmtWei(cfg.maxGasCostWei, px)}, total budget ${fmtWei(cfg.totalGasBudgetWei, px)}.`);
}

main().catch((e) => {
  console.error(errText(e));
  process.exit(1);
});
