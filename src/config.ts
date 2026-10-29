import "dotenv/config";
import { getAddress, parseEther, parseGwei, type Address, type Hex } from "viem";
import { SEADROP_ADDRESS } from "./drops.js";

export interface Config {
  chainId: number;
  /** One or more RPC URLs; extra ones are failover. Empty = chain default. */
  rpcUrls: string[];
  rpcTimeoutMs: number;
  /**
   * RPC endpoints for the actions that need to be fast and reliable: simulating, estimating, sending,
   * balances, receipts. A metered provider with a free quota fits here, because a mint costs a few
   * hundred units while the block watcher would use a whole month's quota in a day. The RPC_URLS
   * endpoints stay as the backup. Empty: everything uses RPC_URLS.
   */
  actionRpcUrls: string[];
  /** Most HTTP requests in flight to the RPC at once. Free RPCs stall when flooded. */
  rpcMaxInflight: number;
  /** Most collections the bot works on at once, so mint checks never starve the block watcher. */
  maxConcurrentRounds: number;
  /** Wallet sources (all are merged and de-duplicated). */
  privateKeys: Hex[];
  keysFile: string | undefined;
  mnemonic: string | undefined;
  walletCount: number;
  dryRun: boolean;
  pollIntervalMs: number;
  /** Fast discovery: one batched request per tick for blocks + transactions + mint logs. */
  liveFeed: boolean;
  /** Optional WebSocket endpoint: new blocks are pushed instead of polled (needs a provider that offers it). */
  rpcWsUrl: string | undefined;
  /** Start every wallet as soon as the free simulation proves the mint delivers, without waiting for a receipt. */
  fastMode: boolean;
  /** Spot drops from on-chain announcements (SeaDrop) and mint the moment they open. */
  drops: boolean;
  /** SeaDrop contract to watch for announcements; undefined disables it. */
  seaDropAddress: Address | undefined;
  /** Only arm drops starting within this many seconds. */
  dropLeadSec: number;
  /** Tokens per wallet per drop (capped by the drop's own per-wallet limit). */
  dropQuantity: number;
  /** Gas limit used for drop mints (an estimate cannot be made before the drop opens). */
  dropGasLimit: bigint;
  /** How often an armed drop is checked once its start time is near. */
  dropPollMs: number;
  /** Most drops that may be armed (waiting) at once. */
  maxArmedDrops: number;
  /** How many recent blocks a collection's mint activity is measured over. */
  windowBlocks: number;
  /** At startup, scan only this many recent blocks (<= windowBlocks). Sweeping needs new mints, not old ones. */
  backfillBlocks: number;
  /** Minimum distinct wallets that must have free-minted in the window. */
  minUniqueMinters: number;
  /** Minimum free mint transactions in the window. */
  minMintTxs: number;
  /** Thresholds applied instead to allowlisted collections (snipe mode). */
  allowlistMinUniqueMinters: number;
  allowlistMinMintTxs: number;
  /** Max mint txs each of our wallets sends per collection. */
  maxMintsPerCollection: number;
  /** At most this many of our wallets mint each collection (0 = all). Cuts gas roughly N-fold. */
  maxWalletsPerCollection: number;
  /** Max wallets minting concurrently. */
  walletConcurrency: number;
  /** Hard cap on gas fee spent per mint tx. */
  maxGasCostWei: bigint;
  /** Kill switch: stop sending once total gas spent across all wallets hits this. */
  totalGasBudgetWei: bigint;
  maxFeePerGasWei: bigint | undefined;
  /** Skip minting while the chain base fee is above this (cheapest way to avoid overpaying). */
  maxBaseFeeWei: bigint | undefined;
  /** Follow the node's suggested tip instead of PRIORITY_FEE_GWEI. Off by default: Orbit chains order FCFS, so a tip buys nothing. */
  useSuggestedTip: boolean;
  /** Priority fee to bid for sequencer ordering (0 is normal on Arbitrum Orbit). */
  priorityFeeWei: bigint;
  /** maxFeePerGas = baseFee * this + tip. Headroom so base-fee spikes don't strand txs. */
  baseFeeMultiplier: number;
  /** How often to poll for receipts / new blocks. */
  receiptPollMs: number;
  /** Require the collection to report ERC-721/1155 via ERC-165. */
  requireErc165: boolean;
  /** Mint ANY new collection whose observed mints were all free (after vetting), not just crowded ones. */
  sweepAll: boolean;
  /** Only mint collections whose source code is verified on the explorer. */
  requireVerified: boolean;
  /** Screen the mint call with debug_traceCall when the RPC supports it. */
  vetTrace: boolean;
  /** Blockscout-compatible explorer base URL used for the verification check. */
  explorerApi: string | undefined;
  receiptTimeoutMs: number;
  denylist: Set<Address>;
  allowlist: Set<Address>;
  stateFile: string;
  /** Where `npm run collect` sends minted NFTs. */
  vaultAddress: Address | undefined;
  /** Funder key for `npm run fund` / destination for `npm run recover`. */
  funderPrivateKey: Hex | undefined;
  fundTargetWei: bigint;
}

type Env = Record<string, string | undefined>;

function list(v: string | undefined): string[] {
  return (v ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return !["false", "0", "no", "off"].includes(raw);
}

/** Robinhood Chain's floor is 0.02 gwei, so the default ceiling only makes sense there. */
function baseFeeCap(env: Env): bigint | undefined {
  const raw = env.MAX_BASE_FEE_GWEI?.trim();
  if (raw === "off") return undefined;
  if (raw) return parseGwei(raw);
  return (env.CHAIN_ID ?? "4663") === "4663" ? parseGwei("0.05") : undefined;
}

export function normalizeKey(k: string): Hex {
  const key = (k.startsWith("0x") ? k : `0x${k}`).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(key)) throw new Error("Invalid private key (expected 32 bytes hex)");
  return key as Hex;
}

export function loadConfig(env: Env = process.env, opts: { requireWallets?: boolean } = {}): Config {
  const dryRun = bool(env, "DRY_RUN", true);
  const mnemonic = env.MNEMONIC?.trim() || undefined;
  const cfg: Config = {
    chainId: int(env, "CHAIN_ID", 4663),
    rpcUrls: list(env.RPC_URLS ?? env.RPC_URL),
    rpcTimeoutMs: int(env, "RPC_TIMEOUT_MS", 5000),
    actionRpcUrls: list(env.ACTION_RPC_URLS),
    rpcMaxInflight: Math.max(1, int(env, "RPC_MAX_INFLIGHT", 6)),
    maxConcurrentRounds: Math.max(1, int(env, "MAX_CONCURRENT_ROUNDS", 3)),
    privateKeys: list(env.PRIVATE_KEYS ?? env.PRIVATE_KEY).map(normalizeKey),
    keysFile: env.KEYS_FILE || undefined,
    mnemonic,
    walletCount: int(env, "WALLET_COUNT", mnemonic ? 20 : 0),
    dryRun,
    // Blocks arrive every ~100 ms, so a 1 s poll could add a whole second of delay.
    pollIntervalMs: int(env, "POLL_INTERVAL_MS", 100),
    liveFeed: bool(env, "LIVE_FEED", true),
    rpcWsUrl: env.RPC_WS_URL || undefined,
    fastMode: bool(env, "FAST_MODE", true),
    drops: bool(env, "DROPS", true),
    // SeaDrop sits at the same address on every chain; only Robinhood Chain gets it by default.
    seaDropAddress: env.SEADROP_ADDRESS ? getAddress(env.SEADROP_ADDRESS) : (env.CHAIN_ID ?? "4663") === "4663" ? SEADROP_ADDRESS : undefined,
    dropLeadSec: int(env, "DROP_LEAD_HOURS", 24) * 3600,
    dropQuantity: Math.max(1, int(env, "DROP_QUANTITY", 1)),
    dropGasLimit: BigInt(int(env, "DROP_GAS_LIMIT", 220_000)),
    dropPollMs: Math.max(50, int(env, "DROP_POLL_MS", 250)),
    maxArmedDrops: int(env, "MAX_ARMED_DROPS", 60),
    // Robinhood Chain makes ~10 blocks per second: 6000 blocks is about 10 minutes.
    windowBlocks: int(env, "WINDOW_BLOCKS", 6000),
    backfillBlocks: int(env, "BACKFILL_BLOCKS", 1200),
    minUniqueMinters: int(env, "MIN_UNIQUE_MINTERS", 15),
    minMintTxs: int(env, "MIN_MINT_TXS", 20),
    allowlistMinUniqueMinters: int(env, "ALLOWLIST_MIN_UNIQUE_MINTERS", 1),
    allowlistMinMintTxs: int(env, "ALLOWLIST_MIN_MINT_TXS", 1),
    maxMintsPerCollection: int(env, "MAX_MINTS_PER_COLLECTION", 1),
    maxWalletsPerCollection: int(env, "MAX_WALLETS_PER_COLLECTION", 0),
    walletConcurrency: Math.max(1, int(env, "WALLET_CONCURRENCY", 25)),
    maxGasCostWei: parseEther(env.MAX_GAS_COST_ETH || "0.0005"),
    totalGasBudgetWei: parseEther(env.TOTAL_GAS_BUDGET_ETH || "0.05"),
    maxFeePerGasWei: env.MAX_FEE_PER_GAS_GWEI ? parseGwei(env.MAX_FEE_PER_GAS_GWEI) : undefined,
    priorityFeeWei: parseGwei(env.PRIORITY_FEE_GWEI || "0"),
    // The chain's base-fee floor is 0.02 gwei; 0.05 lets normal days through and pauses
    // minting during spikes like Aug 2026's (23x). Set MAX_BASE_FEE_GWEI=off to disable.
    maxBaseFeeWei: baseFeeCap(env),
    useSuggestedTip: bool(env, "USE_SUGGESTED_TIP", false),
    baseFeeMultiplier: Number(env.BASE_FEE_MULTIPLIER || "2"),
    receiptPollMs: Math.max(50, int(env, "RECEIPT_POLL_MS", 250)),
    requireErc165: bool(env, "REQUIRE_ERC165", true),
    sweepAll: bool(env, "SWEEP_ALL", true),
    requireVerified: bool(env, "REQUIRE_VERIFIED", false),
    vetTrace: bool(env, "VET_TRACE", true),
    explorerApi: env.EXPLORER_API || (env.CHAIN_ID === undefined || env.CHAIN_ID === "4663" ? "https://robinhoodchain.blockscout.com" : undefined),
    receiptTimeoutMs: int(env, "RECEIPT_TIMEOUT_MS", 60_000),
    denylist: new Set(list(env.DENYLIST).map((a) => getAddress(a))),
    allowlist: new Set(list(env.ALLOWLIST).map((a) => getAddress(a))),
    stateFile: env.STATE_FILE || "state.json",
    vaultAddress: env.VAULT_ADDRESS ? getAddress(env.VAULT_ADDRESS) : undefined,
    funderPrivateKey: env.FUNDER_PRIVATE_KEY ? normalizeKey(env.FUNDER_PRIVATE_KEY) : undefined,
    fundTargetWei: parseEther(env.FUND_TARGET_ETH || "0.002"),
  };
  if (!(cfg.baseFeeMultiplier >= 1)) throw new Error("BASE_FEE_MULTIPLIER must be >= 1");
  if (opts.requireWallets !== false && !dryRun && cfg.privateKeys.length === 0 && !cfg.keysFile && !cfg.mnemonic) {
    throw new Error("Live mode needs wallets: set PRIVATE_KEYS, KEYS_FILE or MNEMONIC");
  }
  return cfg;
}
