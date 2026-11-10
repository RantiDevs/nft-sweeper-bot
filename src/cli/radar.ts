import "dotenv/config";
import { runRadar } from "../radar.js";
import { enrich } from "../radar-enrich.js";
import { mapLimit } from "../util.js";

/** npm run radar -- [hours-window=3] [lookback-hours=48] */
const windowH = Number(process.argv[2] ?? 3);
const lookH = Number(process.argv[3] ?? 48);
const rh = (process.env.RPC_URLS ?? process.env.RPC_URL ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const now = Math.floor(Date.now() / 1000);

const t0 = Date.now();
const { hits, reports, rpcs } = await runRadar({ windowSec: windowH * 3600, lookbackHours: lookH, rpcOverrides: { 4663: rh }, nowSec: now });
const rich = await mapLimit(hits, 4, (h) => enrich(h, rpcs.get(h.chainId)!, process.env.OPENSEA_API_KEY, now));

const usd = (n?: number) => (n === undefined ? "?" : `$${n.toFixed(2)}`);
console.log(`\nFree public SeaDrop mints live now or opening within ${windowH}h (announced in the last ${lookH}h), ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
if (rich.length === 0) console.log("  none found");
for (const v of ["WORTH A LOOK", "SKIP"] as const) {
  for (const h of rich.filter((r) => r.verdict === v)) {
    const when = h.state === "LIVE" ? "LIVE" : `opens in ${Math.round(h.opensInSec / 60)} min`;
    const left = h.remaining !== undefined && h.max !== undefined ? `${h.remaining}/${h.max} left` : "supply ?";
    console.log(`[${v}] ${h.chain} ${h.drop.nft}\n    ${when} | max ${h.drop.maxPerWallet}/wallet | ${left} | floor ${usd(h.floorUsd)} | holders ${h.owners ?? "?"} | 24h sales ${h.sales24h ?? "?"}${h.slug ? ` | https://opensea.io/collection/${h.slug}` : ""}`);
    if (h.reasons.length) console.log(`    why skipped: ${h.reasons.join("; ")}`);
  }
}
console.log("\nPer chain:");
for (const r of reports) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.chain.padEnd(16)} ${String(r.announcements).padStart(5)} drops  ${r.note}  (${(r.tookMs / 1000).toFixed(1)}s)`);
