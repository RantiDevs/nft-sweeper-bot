import type { PlanSummary } from "./plan.js";

const usd = (n: number) => `$${n.toFixed(2)}`;

/** Human summary of a plan; `html` escapes nothing because no untrusted text is included. */
export function formatPlan(p: PlanSummary, opts: { html: boolean }): string {
  const b = (s: string) => (opts.html ? `<b>${s}</b>` : s);
  const lines = [b(`Plan for ${p.rows.length} NFT(s)`)];
  for (const t of p.byTier) if (t.count || !p.dead) lines.push(`${t.label}: ${t.count}${t.listUsd ? ` (listed ${usd(t.listUsd)})` : ""}`);
  if (p.holdValueUsd) lines.push(`Held NFTs are worth about ${usd(p.holdValueUsd)} at current floors`);
  if (p.wait) lines.push(`WAIT: ${p.wait}: no market yet, unrevealed, or data unavailable`);
  if (p.dead) lines.push(`DEAD: ${p.dead}: no sales since mint or worth pennies; leave them`);
  lines.push("");
  lines.push(`If every listing sells: ${usd(p.listUsd)} listed → ${usd(p.proceedsUsd)} after fees`);
  if (p.gasSpentUsd !== undefined) {
    lines.push(`Gas spent so far: ${usd(p.gasSpentUsd)}`);
    lines.push(`Profit if all sell: ${usd(p.profitIfAllSellUsd ?? 0)}`);
    if (p.breakEvenPct !== undefined) lines.push(`Break-even: ${p.breakEvenPct.toFixed(1)}% of listings need to sell`);
  } else {
    lines.push("Set the ETH price to see gas cost, profit and break-even.");
  }
  lines.push("");
  lines.push("Prices come from real sales (wash trades removed) and OpenSea floors when a key is set, with a rarity premium on top. Most free mints never trade, and nothing here predicts the future: re-run /plan as the market moves.");
  return lines.join("\n");
}
