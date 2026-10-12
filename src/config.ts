import "dotenv/config";
import { getAddress, parseEther, parseGwei, type Address, type Hex } from "viem";

export interface Config {
  chainId: number;
  /** One or more RPC URLs; extra ones are failover. Empty = chain default. */
  rpcUrls: string[];
  rpcTimeoutMs: number;
  /** Wallet sources (all are merged and de-duplicated). */
  privateKeys: Hex[];
  keysFile: string | undefined;
  mnemonic: string | undefined;
  walletCount: number;
  dryRun: boolean;
  pollIntervalMs: number;
  /** How many recent blocks a collection's mint activity is measured over. */
  windowBlocks: number;
  /** Minimum distinct wallets that must have free-minted in the window. */
  minUniqueMinters: number;
  /** Minimum free mint transactions in the window. */
  minMintTxs: number;
  /** Thresholds applied instead to allowlisted collections (snipe mode). */
  allowlistMinUniqueMinters: number;
  allowlistMinMintTxs: number;
  /** Max mint txs each of our wallets sends per collection. */
  maxMintsPerCollection: number;
  /** Max wallets minting concurrently. */
  walletConcurrency: number;
  /** Hard cap on gas fee spent per mint tx. */
  maxGasCostWei: bigint;
  /** Kill switch: stop sending once total gas spent across all wallets hits this. */
  totalGasBudgetWei: bigint;
  maxFeePerGasWei: bigint | undefined;
  /** Priority fee to bid for sequencer ordering (0 is normal on Arbitrum Orbit). */
  priorityFeeWei: bigint;
  /** maxFeePerGas = baseFee * this + tip. Headroom so base-fee spikes don't strand txs. */
  baseFeeMultiplier: number;
  /** How often to poll for receipts / new blocks. */
  receiptPollMs: number;
  /** Require the collection to report ERC-721/1155 via ERC-165. */
  requireErc165: boolean;
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

export function normalizeKey(k: string): Hex {
  const key = (k.startsWith("0x") ? k : `0x${k}`).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(key)) throw new Error("Invalid private key (expected 32 bytes hex)");
  return key as Hex;
}

export function loadConfig(env: Env = process.env): Config {
  const dryRun = bool(env, "DRY_RUN", true);
  const mnemonic = env.MNEMONIC?.trim() || undefined;
  const cfg: Config = {
    chainId: int(env, "CHAIN_ID", 4663),
    rpcUrls: list(env.RPC_URLS ?? env.RPC_URL),
    rpcTimeoutMs: int(env, "RPC_TIMEOUT_MS", 5000),
    privateKeys: list(env.PRIVATE_KEYS ?? env.PRIVATE_KEY).map(normalizeKey),
    keysFile: env.KEYS_FILE || undefined,
    mnemonic,
    walletCount: int(env, "WALLET_COUNT", mnemonic ? 20 : 0),
    dryRun,
    pollIntervalMs: int(env, "POLL_INTERVAL_MS", 1000),
    windowBlocks: int(env, "WINDOW_BLOCKS", 1200),
    minUniqueMinters: int(env, "MIN_UNIQUE_MINTERS", 15),
    minMintTxs: int(env, "MIN_MINT_TXS", 20),
    allowlistMinUniqueMinters: int(env, "ALLOWLIST_MIN_UNIQUE_MINTERS", 1),
    allowlistMinMintTxs: int(env, "ALLOWLIST_MIN_MINT_TXS", 1),
    maxMintsPerCollection: int(env, "MAX_MINTS_PER_COLLECTION", 1),
    walletConcurrency: Math.max(1, int(env, "WALLET_CONCURRENCY", 25)),
    maxGasCostWei: parseEther(env.MAX_GAS_COST_ETH || "0.0005"),
    totalGasBudgetWei: parseEther(env.TOTAL_GAS_BUDGET_ETH || "0.05"),
    maxFeePerGasWei: env.MAX_FEE_PER_GAS_GWEI ? parseGwei(env.MAX_FEE_PER_GAS_GWEI) : undefined,
    priorityFeeWei: parseGwei(env.PRIORITY_FEE_GWEI || "0"),
    baseFeeMultiplier: Number(env.BASE_FEE_MULTIPLIER || "2"),
    receiptPollMs: Math.max(50, int(env, "RECEIPT_POLL_MS", 250)),
    requireErc165: bool(env, "REQUIRE_ERC165", true),
    receiptTimeoutMs: int(env, "RECEIPT_TIMEOUT_MS", 60_000),
    denylist: new Set(list(env.DENYLIST).map((a) => getAddress(a))),
    allowlist: new Set(list(env.ALLOWLIST).map((a) => getAddress(a))),
    stateFile: env.STATE_FILE || "state.json",
    vaultAddress: env.VAULT_ADDRESS ? getAddress(env.VAULT_ADDRESS) : undefined,
    funderPrivateKey: env.FUNDER_PRIVATE_KEY ? normalizeKey(env.FUNDER_PRIVATE_KEY) : undefined,
    fundTargetWei: parseEther(env.FUND_TARGET_ETH || "0.002"),
  };
  if (!(cfg.baseFeeMultiplier >= 1)) throw new Error("BASE_FEE_MULTIPLIER must be >= 1");
  if (!dryRun && cfg.privateKeys.length === 0 && !cfg.keysFile && !cfg.mnemonic) {
    throw new Error("Live mode needs wallets: set PRIVATE_KEYS, KEYS_FILE or MNEMONIC");
  }
  return cfg;
}
