import { formatEther } from "viem";

/** "$1,234.56", with extra decimals for tiny amounts so gas costs don't all show as "$0.00". */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "$?";
  const abs = Math.abs(n);
  const digits = abs === 0 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 3 : abs >= 0.0001 ? 5 : 7;
  const s = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits });
  return `${n < 0 ? "-" : ""}$${s}`;
}

export function weiToUsd(wei: bigint, ethUsd: number): number {
  return Number(formatEther(wei)) * ethUsd;
}

export function ethToUsd(eth: number, ethUsd: number): number {
  return eth * ethUsd;
}

/** "$0.42 (0.00014 ETH)" when the price is known, otherwise just the ETH amount. */
export function fmtWei(wei: bigint, ethUsd: number | undefined, ethDigits = 6): string {
  const e = Number(formatEther(wei));
  const eth = `${e === 0 ? "0" : e.toFixed(ethDigits).replace(/\.?0+$/, "")} ETH`;
  return ethUsd === undefined ? eth : `${fmtUsd(e * ethUsd)} (${eth})`;
}

export type Money = { ok: true; eth: string } | { ok: false; error: string };

/**
 * Reads an amount typed by a user. A bare number or "$2" is dollars; "0.001eth" is ETH.
 * Gas is paid in ETH, so dollars are converted at the current price and stored as ETH.
 */
export function parseMoney(input: string, ethUsd: number | undefined): Money {
  const s = input.trim().toLowerCase().replace(/,/g, "");
  const eth = /^(\d+(?:\.\d{1,18})?)\s*eth$/.exec(s);
  if (eth) return { ok: true, eth: eth[1] };
  const usd = /^\$?(\d+(?:\.\d{1,8})?)$/.exec(s);
  if (!usd) return { ok: false, error: "Give an amount in dollars, e.g. 2 or $2 (or in ETH, e.g. 0.001eth)" };
  if (ethUsd === undefined) return { ok: false, error: "The ETH price isn't available right now. Give the amount in ETH instead, e.g. 0.001eth" };
  const value = Number(usd[1]) / ethUsd;
  // Round up to 12 decimals so a dollar cap never converts to slightly less than asked.
  const text = (Math.ceil(value * 1e12) / 1e12).toFixed(12).replace(/\.?0+$/, "");
  return { ok: true, eth: text === "" ? "0" : text };
}
