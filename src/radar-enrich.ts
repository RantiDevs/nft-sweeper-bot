import { decodeFunctionResult, encodeFunctionData, parseAbi, zeroAddress, type Address } from "viem";
import { DEFAULT_FEE_RECIPIENT, seaDropAbi } from "./drops.js";
import type { RadarHit, Rpc } from "./radar.js";

/**
 * Turns a raw announcement into a decision. The lesson from Enter Elysium: an announced free mint can already be
 * sold out, and OpenSea's "supply" is not the minted count. So every hit is checked ON-CHAIN (remaining supply,
 * and a simulated mint from a stranger address), and its price is checked on OpenSea. A hit is only "WORTH A LOOK"
 * if all of that holds; otherwise the reason is printed.
 */

const OPENSEA = "https://api.opensea.io/api/v2";

/** OpenSea's name for each chain. */
export const OPENSEA_CHAIN: Record<number, string> = {
  1: "ethereum", 8453: "base", 42161: "arbitrum", 10: "optimism", 137: "matic", 999: "hyperevm", 99901: "elysium",
  4663: "robinhood", 2741: "abstract", 57073: "ink", 130: "unichain", 1868: "soneium", 360: "shape", 1329: "sei",
  2020: "ronin", 33139: "ape_chain", 143: "monad", 4326: "megaeth", 747: "flow", 56: "bsc", 43114: "avalanche",
  7777777: "zora", 81457: "blast",
};

export type Verdict = "WORTH A LOOK" | "SKIP";

/** Thresholds for "worth a look". */
export interface Criteria {
  minFloorUsd: number;
  minHolders: number;
  minMinutesLeft: number;
}
export const DEFAULT_CRITERIA: Criteria = { minFloorUsd: 1, minHolders: 20, minMinutesLeft: 10 };

export interface Enriched extends RadarHit {
  minted?: bigint;
  max?: bigint;
  remaining?: bigint;
  mintable?: "yes" | "no" | "unknown";
  mintNote?: string;
  slug?: string;
  floorNative?: number;
  floorUsd?: number;
  owners?: number;
  sales24h?: number;
  verdict: Verdict;
  reasons: string[];
}

const supplyAbi = parseAbi(["function totalSupply() view returns (uint256)", "function maxSupply() view returns (uint256)"]);
const claimAbi = parseAbi([
  "struct AllowlistProof { bytes32[] proof; uint256 quantityLimitPerWallet; uint256 pricePerToken; address currency; }",
  "function claim(address receiver, uint256 quantity, address currency, uint256 pricePerToken, AllowlistProof allowlistProof, bytes data) payable",
]);

async function call(rpc: Rpc, to: Address, data: `0x${string}`, from?: Address): Promise<{ ok: boolean; data?: `0x${string}`; error?: string }> {
  try {
    const r = await rpc("eth_call", [{ to, data, ...(from ? { from } : {}) }, "latest"]);
    return { ok: true, data: r };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 80) };
  }
}

async function osGet(key: string | undefined, path: string): Promise<any | undefined> {
  if (!key) return undefined;
  try {
    const res = await fetch(`${OPENSEA}${path}`, { headers: { "x-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

/** The call a stranger's wallet would make to mint one token, or undefined if we cannot build it. */
async function testMintCall(hit: RadarHit, rpc: Rpc): Promise<{ to: Address; data: `0x${string}` } | undefined> {
  const d = hit.drop;
  if (d.platform === "thirdweb") {
    const currency = d.currency ?? ("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address);
    return {
      to: d.nft,
      data: encodeFunctionData({
        abi: claimAbi,
        functionName: "claim",
        args: ["0x000000000000000000000000000000000000bEEF" as Address, 1n, currency, 0n, { proof: [], quantityLimitPerWallet: 0n, pricePerToken: 0n, currency }, "0x"],
      }),
    };
  }
  let recipient: Address | undefined = DEFAULT_FEE_RECIPIENT;
  if (d.restrictFeeRecipients) {
    const r = await call(rpc, d.mintTo, encodeFunctionData({ abi: seaDropAbi, functionName: "getAllowedFeeRecipients", args: [d.nft] }));
    recipient = r.ok && r.data ? decodeFunctionResult({ abi: seaDropAbi, functionName: "getAllowedFeeRecipients", data: r.data })[0] : undefined;
  }
  if (!recipient) return undefined;
  return { to: d.mintTo, data: encodeFunctionData({ abi: seaDropAbi, functionName: "mintPublic", args: [d.nft, recipient, zeroAddress, 1n] }) };
}

export async function enrich(hit: RadarHit, rpc: Rpc, openseaKey: string | undefined, nowSec: number, crit: Criteria = DEFAULT_CRITERIA): Promise<Enriched> {
  const nft = hit.drop.nft;
  const out: Enriched = { ...hit, verdict: "SKIP", reasons: [] };
  const why = out.reasons;

  // 1. Supply, from the contract itself.
  const ts = await call(rpc, nft, encodeFunctionData({ abi: supplyAbi, functionName: "totalSupply" }));
  const ms = await call(rpc, nft, encodeFunctionData({ abi: supplyAbi, functionName: "maxSupply" }));
  try {
    if (ts.ok && ts.data && ts.data !== "0x") out.minted = decodeFunctionResult({ abi: supplyAbi, functionName: "totalSupply", data: ts.data });
    if (ms.ok && ms.data && ms.data !== "0x") out.max = decodeFunctionResult({ abi: supplyAbi, functionName: "maxSupply", data: ms.data });
  } catch {
    /* unreadable: handled below */
  }
  out.max ??= hit.drop.maxClaimable;
  if (out.minted !== undefined && out.max !== undefined && out.max > 0n) {
    out.remaining = out.max > out.minted ? out.max - out.minted : 0n;
    if (out.remaining === 0n) why.push(`SOLD OUT on-chain (${out.minted}/${out.max})`);
    else if (out.remaining * 20n < out.max) why.push(`under 5% left (${out.remaining}/${out.max})`);
  } else {
    why.push("could not read supply from the contract");
  }

  // 2. A simulated mint from a stranger address. Fails for gated, paused, or broken contracts.
  try {
    const m = await testMintCall(hit, rpc);
    if (!m) {
      out.mintable = "unknown";
      why.push("could not build a test mint");
    } else {
      const sim = await call(rpc, m.to, m.data, "0x000000000000000000000000000000000000bEEF" as Address);
      out.mintable = sim.ok ? "yes" : "no";
      if (!sim.ok) {
        out.mintNote = sim.error;
        // Before the stage opens a revert is expected. Only a revert on a LIVE stage is disqualifying.
        if (hit.state === "LIVE") why.push(`test mint reverts (${sim.error})`);
      }
    }
  } catch {
    out.mintable = "unknown";
  }

  // 3. Market data from OpenSea.
  const osChain = OPENSEA_CHAIN[hit.chainId];
  const contract = osChain ? await osGet(openseaKey, `/chain/${osChain}/contract/${nft}`) : undefined;
  out.slug = contract?.collection;
  if (!openseaKey) why.push("no OpenSea key: price unknown");
  else if (!out.slug) why.push("not indexed on OpenSea yet: no price data");
  if (out.slug) {
    const [col, stats] = await Promise.all([osGet(openseaKey, `/collections/${out.slug}`), osGet(openseaKey, `/collections/${out.slug}/stats`)]);
    const usd = Number(col?.pricing_currencies?.listing_currency?.usd_price);
    const t = stats?.total;
    if (t?.floor_price && usd) {
      out.floorNative = Number(t.floor_price);
      out.floorUsd = out.floorNative * usd;
    }
    out.owners = t?.num_owners;
    out.sales24h = stats?.intervals?.find((i: any) => i.interval === "one_day")?.sales;
    if (out.floorUsd === undefined) why.push("no floor price (nothing listed)");
    else if (out.floorUsd < crit.minFloorUsd) why.push(`floor under $${crit.minFloorUsd} ($${out.floorUsd.toFixed(2)})`);
    if ((out.owners ?? 0) > 0 && (out.owners ?? 0) < crit.minHolders) why.push(`only ${out.owners} holders`);
  }

  // 4. The window must still be open long enough to act.
  const secLeft = hit.drop.endTime - nowSec;
  if (secLeft < crit.minMinutesLeft * 60) why.push(`stage ends in ${Math.max(0, Math.round(secLeft / 60))} min`);

  out.verdict = why.length === 0 ? "WORTH A LOOK" : "SKIP";
  return out;
}
