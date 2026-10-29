import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address } from "viem";

export interface UserSettings {
  /** New users start in dry-run: the bot simulates and reports but sends nothing. */
  dryRun: boolean;
  paused: boolean;
  /** true: mint every new vetted free collection; false: only ones many wallets are minting. */
  sweep: boolean;
  maxGasCostEth: string;
  totalGasBudgetEth: string;
  minUniqueMinters: number;
  minMintTxs: number;
  maxMintsPerCollection: number;
  /** Wallets that mint each collection; 0 = all of them. */
  walletsPerCollection: number;
  allowlist: Address[];
  denylist: Address[];
  /** Where /collect sends minted NFTs. */
  vault?: Address;
  notify: boolean;
  /** /plan inputs; unset values fall back to the operator defaults. */
  ethUsd?: number;
  feePct?: number;
  tiers?: string;
}

export interface StoredWallet {
  address: Address;
  /** AES-256-GCM blob of the private key; see crypto.ts. */
  enc: string;
}

export interface UserRecord {
  id: number;
  username?: string;
  role: "admin" | "user";
  status: "active" | "banned";
  createdAt: number;
  settings: UserSettings;
  wallets: StoredWallet[];
}

interface Invite {
  by: number;
  createdAt: number;
  expiresAt: number;
}

interface Data {
  users: Record<string, UserRecord>;
  invites: Record<string, Invite>;
}

export function defaultSettings(d: {
  maxGasCostEth: string;
  totalGasBudgetEth: string;
  minUniqueMinters: number;
  minMintTxs: number;
}): UserSettings {
  return {
    dryRun: true,
    paused: false,
    sweep: true,
    maxGasCostEth: d.maxGasCostEth,
    totalGasBudgetEth: d.totalGasBudgetEth,
    minUniqueMinters: d.minUniqueMinters,
    minMintTxs: d.minMintTxs,
    maxMintsPerCollection: 1,
    walletsPerCollection: 0,
    allowlist: [],
    denylist: [],
    notify: true,
  };
}

/** JSON-file user database. Writes are atomic (temp file + rename). */
export class UserStore {
  private data: Data = { users: {}, invites: {} };

  constructor(private file: string) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) this.data = { ...this.data, ...JSON.parse(readFileSync(file, "utf8")) };
  }

  get(id: number): UserRecord | undefined {
    return this.data.users[String(id)];
  }

  all(): UserRecord[] {
    return Object.values(this.data.users);
  }

  count(): number {
    return Object.keys(this.data.users).length;
  }

  create(rec: UserRecord): UserRecord {
    this.data.users[String(rec.id)] = rec;
    this.save();
    return rec;
  }

  save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    // Keep the previous version: users.json holds the only copy of every user's
    // encrypted keys, so a bad write must never be unrecoverable.
    if (existsSync(this.file)) copyFileSync(this.file, `${this.file}.bak`);
    renameSync(tmp, this.file);
  }

  createInvite(by: number, ttlMs = 7 * 24 * 3600_000): string {
    const code = randomBytes(9).toString("base64url");
    this.data.invites[code] = { by, createdAt: Date.now(), expiresAt: Date.now() + ttlMs };
    this.save();
    return code;
  }

  /** Single-use: a valid code is consumed and returns true. */
  consumeInvite(code: string): boolean {
    const inv = this.data.invites[code];
    if (!inv) return false;
    delete this.data.invites[code];
    this.save();
    return inv.expiresAt > Date.now();
  }

  openInvites(): number {
    return Object.values(this.data.invites).filter((i) => i.expiresAt > Date.now()).length;
  }
}
