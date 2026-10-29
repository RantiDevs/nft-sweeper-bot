import "dotenv/config";
import { join } from "node:path";
import { loadConfig, type Config } from "../config.js";
import { loadPlanConfig, type PlanConfig } from "../rarity/config.js";
import { parseMasterKey } from "./crypto.js";

type Env = Record<string, string | undefined>;

export interface TgConfig {
  botToken: string;
  masterKey: Buffer;
  adminIds: number[];
  dataDir: string;
  /** Anyone can /start. Off by default: users need an invite code from an admin. */
  openRegistration: boolean;
  maxUsers: number;
  maxWalletsPerUser: number;
  /** Operator-set ceilings: users may tune their limits, but never above these. */
  ceilingMaxGasCostEth: string;
  ceilingTotalGasBudgetEth: string;
  /** Cap on mint attempts in flight across all users, protecting the shared RPC. */
  maxConcurrentMints: number;
  /** Allow /export to show private keys in chat. */
  allowExport: boolean;
  /** Seconds before an exported key message is deleted. */
  exportTtlSec: number;
  /** Seconds without a new block before admins are alerted. */
  stallAlertSec: number;
  /** Minimum gap between one user's commands (flood protection). */
  commandGapMs: number;
  /** Defaults for /plan (users can override tiers, fee and ETH price). */
  plan: PlanConfig;
  /** Rarity analyses allowed at once across all users (they are network-heavy). */
  maxConcurrentPlans: number;
  base: Config;
}

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

export function loadTgConfig(env: Env = process.env): TgConfig {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is required (create one with @BotFather)");
  const adminIds = (env.ADMIN_IDS ?? "")
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`ADMIN_IDS contains an invalid Telegram id: ${s}`);
      return n;
    });
  if (adminIds.length === 0) throw new Error("ADMIN_IDS is required: your numeric Telegram id (ask @userinfobot)");

  // Per-user wallets and live/dry mode come from the store, not env.
  const base = loadConfig({ ...env, DRY_RUN: "true" }, { requireWallets: false });
  return {
    botToken,
    masterKey: parseMasterKey(env.MASTER_KEY),
    adminIds,
    dataDir: env.DATA_DIR || "data",
    openRegistration: (env.OPEN_REGISTRATION ?? "false").toLowerCase() === "true",
    maxUsers: int(env, "MAX_USERS", 100),
    maxWalletsPerUser: int(env, "MAX_WALLETS_PER_USER", 25),
    ceilingMaxGasCostEth: env.CEILING_MAX_GAS_COST_ETH || "0.002",
    ceilingTotalGasBudgetEth: env.CEILING_TOTAL_GAS_BUDGET_ETH || "0.5",
    maxConcurrentMints: Math.max(1, int(env, "MAX_CONCURRENT_MINTS", 60)),
    allowExport: (env.ALLOW_EXPORT ?? "true").toLowerCase() !== "false",
    exportTtlSec: int(env, "EXPORT_TTL_SEC", 60),
    stallAlertSec: int(env, "STALL_ALERT_SEC", 90),
    commandGapMs: int(env, "COMMAND_GAP_MS", 500),
    plan: loadPlanConfig(env, { cacheDir: join(env.DATA_DIR || "data", "metadata") }),
    maxConcurrentPlans: Math.max(1, int(env, "MAX_CONCURRENT_PLANS", 2)),
    base,
  };
}

export const usersFile = (c: TgConfig) => join(c.dataDir, "users.json");
export const stateFile = (c: TgConfig, id: number) => join(c.dataDir, "state", `${id}.json`);
