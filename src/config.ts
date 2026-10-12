import "dotenv/config";
import { getAddress, parseEther, parseGwei, type Address, type Hex } from "viem";

export interface Config {
  chainId: number;
  rpcUrl: string | undefined;
  privateKeys: Hex[];
  dryRun: boolean;
  pollIntervalMs: number;
  /** How many recent blocks a collection's mint activity is measured over. */
  windowBlocks: number;
  /** Minimum distinct wallets that must have free-minted in the window. */
  minUniqueMinters: number;
  /** Minimum free mint transactions in the window. */
  minMintTxs: number;
  /** Max mint txs each of our wallets sends per collection. */
  maxMintsPerCollection: number;
  /** Hard cap on gas fee spent per mint tx. */
  maxGasCostWei: bigint;
  maxFeePerGasWei: bigint | undefined;
  denylist: Set<Address>;
  allowlist: Set<Address>;
  stateFile: string;
}

function list(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

export function loadConfig(env = process.env): Config {
  const privateKeys = list(env.PRIVATE_KEYS ?? env.PRIVATE_KEY).map((k) =>
    (k.startsWith("0x") ? k : `0x${k}`) as Hex,
  );
  const dryRun = (env.DRY_RUN ?? "true").toLowerCase() !== "false";
  if (!dryRun && privateKeys.length === 0) {
    throw new Error("PRIVATE_KEYS is required when DRY_RUN=false");
  }
  return {
    chainId: int(env, "CHAIN_ID", 4663),
    rpcUrl: env.RPC_URL || undefined,
    privateKeys,
    dryRun,
    pollIntervalMs: int(env, "POLL_INTERVAL_MS", 2000),
    windowBlocks: int(env, "WINDOW_BLOCKS", 1200),
    minUniqueMinters: int(env, "MIN_UNIQUE_MINTERS", 15),
    minMintTxs: int(env, "MIN_MINT_TXS", 20),
    maxMintsPerCollection: int(env, "MAX_MINTS_PER_COLLECTION", 1),
    maxGasCostWei: parseEther(env.MAX_GAS_COST_ETH || "0.0005"),
    maxFeePerGasWei: env.MAX_FEE_PER_GAS_GWEI ? parseGwei(env.MAX_FEE_PER_GAS_GWEI) : undefined,
    denylist: new Set(list(env.DENYLIST).map((a) => getAddress(a))),
    allowlist: new Set(list(env.ALLOWLIST).map((a) => getAddress(a))),
    stateFile: env.STATE_FILE || "state.json",
  };
}
