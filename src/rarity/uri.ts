import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";

/**
 * Fetching NFT metadata safely.
 *
 * tokenURI values are chosen by whoever deployed the contract, so they are
 * untrusted input. On a server (the Telegram bot) a URI like
 * http://169.254.169.254/ or http://localhost:8545/ would make the bot probe its
 * own network. Every connection is therefore checked at connect time (so DNS
 * rebinding can't slip past) to reach only public addresses, responses are
 * size- and time-limited, and only http(s), ipfs://, ar:// and data: are allowed.
 */

export const DEFAULT_IPFS_GATEWAYS = ["https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://gateway.pinata.cloud/ipfs/"];
const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateIp(mapped[1]);
    return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s) || s.startsWith("64:ff9b:") || s.startsWith("2001:db8");
  }
  return true; // not an IP at all: refuse
}

/** DNS lookup that refuses to hand a private address to the socket. */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as unknown as { address: string; family: number }[];
    const bad = list.find((a) => isPrivateIp(a.address));
    if (bad || list.length === 0) {
      return callback(Object.assign(new Error(`refusing non-public address for ${hostname}`), { code: "EPRIVATE" }), "", 0);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

function getOnce(url: URL, signal: AbortSignal): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      { method: "GET", lookup: publicLookup, signal, headers: { accept: "application/json,*/*;q=0.5", "user-agent": "nft-sweeper-bot" } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ status, location: res.headers.location, body: "" });
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy(new Error("metadata response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** GET a public http(s) URL as text, following a few redirects, each re-checked. */
export async function fetchPublicText(raw: string, timeoutMs = TIMEOUT_MS): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = new URL(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`unsupported protocol ${url.protocol}`);
    if (url.username || url.password) throw new Error("credentials in URL not allowed");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // IP literals skip DNS (and so skip publicLookup): check them here.
    if (isIP(host) && isPrivateIp(host)) throw new Error(`refusing non-public address ${host}`);
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
      throw new Error(`refusing local host ${host}`);
    }
    const res = await getOnce(url, signal);
    if (res.location) {
      url = new URL(res.location, url);
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    return res.body;
  }
  throw new Error("too many redirects");
}

/** Candidate http(s) URLs for a tokenURI (several gateways for IPFS), or the decoded body for data: URIs. */
export function resolveUri(uri: string, gateways = DEFAULT_IPFS_GATEWAYS): { urls: string[] } | { inline: string } {
  const u = uri.trim();
  if (u.startsWith("data:")) {
    const comma = u.indexOf(",");
    if (comma < 0) throw new Error("malformed data URI");
    const meta = u.slice(5, comma);
    const payload = u.slice(comma + 1);
    if (payload.length > MAX_BYTES * 2) throw new Error("data URI too large");
    return { inline: /;base64$/i.test(meta) ? Buffer.from(payload, "base64").toString("utf8") : decodeURIComponentSafe(payload) };
  }
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(u) ?? /^https?:\/\/[^/]+\/ipfs\/(.+)$/i.exec(u);
  if (ipfs) return { urls: gateways.map((g) => g + ipfs[1]) };
  const ar = /^ar:\/\/(.+)$/i.exec(u);
  if (ar) return { urls: [`https://arweave.net/${ar[1]}`] };
  if (/^https?:\/\//i.test(u)) return { urls: [u] };
  throw new Error(`unsupported token URI scheme: ${u.slice(0, 20)}`);
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export type TextFetcher = (url: string) => Promise<string>;

/** Loads and parses the JSON metadata behind a tokenURI, trying each gateway in turn. */
export async function loadMetadata(uri: string, opts: { gateways?: string[]; fetchText?: TextFetcher } = {}): Promise<unknown> {
  const r = resolveUri(uri, opts.gateways);
  if ("inline" in r) return JSON.parse(r.inline);
  const fetchText = opts.fetchText ?? ((url: string) => fetchPublicText(url));
  let last: unknown;
  for (const url of r.urls) {
    try {
      return JSON.parse(await fetchText(url));
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("metadata unavailable");
}
