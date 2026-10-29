import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { errMsg, log, sleep } from "../util.js";
import type { SupabaseKV } from "./supabase.js";

/**
 * Keeps the bot's data folder safe across restarts of a host with a throwaway disk (Render's free tier).
 *
 * The bot keeps writing ordinary files (users.json, state/<id>.json), exactly as before. This class:
 *  - hydrate(): at startup, brings the folder in line with Supabase, so a fresh empty disk comes back
 *    with every user and wallet. The newer copy wins, and anything only present locally is uploaded.
 *  - start(): watches those files and uploads each change within a couple of seconds.
 *  - flush(): pushes anything pending, used on shutdown.
 *
 * It never uploads before hydrate() has succeeded, and a failed hydrate stops the bot from starting:
 * starting with an empty folder and then "saving" it would wipe the stored copy.
 */

const INCLUDED = (rel: string) => rel === "users.json" || /^state\/[0-9]+\.json$/.test(rel);

export interface SyncStatus {
  lastUploadAt?: number;
  pending: number;
  failures: number;
  lastError?: string;
}

export class DataSync {
  private signatures = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private running = false;
  private hydrated = false;
  private failures = 0;
  private lastError?: string;
  private lastUploadAt?: number;
  private nextTryAt = 0;

  constructor(private dir: string, private kv: SupabaseKV, private opts: { pollMs?: number; onTrouble?: (msg: string) => void } = {}) {}

  private walk(): string[] {
    const out: string[] = [];
    const visit = (sub: string) => {
      const abs = join(this.dir, sub);
      if (!existsSync(abs)) return;
      for (const name of readdirSync(abs, { withFileTypes: true })) {
        const rel = sub ? `${sub}/${name.name}` : name.name;
        if (name.isDirectory()) {
          if (rel === "state") visit(rel);
        } else if (INCLUDED(rel)) out.push(rel);
      }
    };
    visit("");
    return out;
  }

  private sig(rel: string): string {
    const st = statSync(join(this.dir, rel));
    return `${st.mtimeMs}:${st.size}`;
  }

  /** Bring this folder and Supabase into agreement. Throws if Supabase cannot be read. */
  async hydrate(): Promise<{ downloaded: number; uploaded: number }> {
    const remote = await this.kv.list(); // throws on failure: the caller must not continue
    const remoteByKey = new Map(remote.map((r) => [r.key, r]));
    let downloaded = 0;
    const toUpload: string[] = [];

    for (const r of remote) {
      if (!INCLUDED(r.key)) continue;
      const abs = join(this.dir, r.key);
      const localMtime = existsSync(abs) ? statSync(abs).mtimeMs : 0;
      if (localMtime > r.updatedAt + 2000) {
        toUpload.push(r.key); // the local file is newer (for example an upload was lost in a crash)
      } else if (!existsSync(abs) || localMtime < r.updatedAt) {
        mkdirSync(dirname(abs), { recursive: true });
        const tmp = `${abs}.tmp`;
        writeFileSync(tmp, JSON.stringify(r.value, null, 2), { mode: 0o600 });
        renameSync(tmp, abs);
        downloaded++;
      }
    }
    for (const rel of this.walk()) if (!remoteByKey.has(rel)) toUpload.push(rel);

    if (toUpload.length) {
      await this.kv.put(toUpload.map((rel) => ({ key: rel, value: JSON.parse(readFileSync(join(this.dir, rel), "utf8")), updatedAt: statSync(join(this.dir, rel)).mtimeMs })));
    }
    for (const rel of this.walk()) this.signatures.set(rel, this.sig(rel));
    this.hydrated = true;
    return { downloaded, uploaded: toUpload.length };
  }

  /** Files whose content changed since the last successful upload. */
  private changed(): string[] {
    return this.walk().filter((rel) => this.signatures.get(rel) !== this.sig(rel));
  }

  /** Uploads everything that changed. Returns true if nothing is left pending. */
  async flush(): Promise<boolean> {
    if (!this.hydrated || this.running) return !this.changed().length;
    this.running = true;
    try {
      const rels = this.changed();
      if (rels.length === 0) return true;
      const entries = rels.map((rel) => {
        const abs = join(this.dir, rel);
        return { rel, sig: this.sig(rel), key: rel, value: JSON.parse(readFileSync(abs, "utf8")) as unknown, updatedAt: statSync(abs).mtimeMs };
      });
      await this.kv.put(entries.map(({ key, value, updatedAt }) => ({ key, value, updatedAt })));
      for (const e of entries) this.signatures.set(e.rel, e.sig);
      this.lastUploadAt = Date.now();
      if (this.failures >= 3) log(`persistence: Supabase is reachable again, ${entries.length} file(s) saved`);
      this.failures = 0;
      this.lastError = undefined;
      return true;
    } catch (e) {
      this.failures++;
      this.lastError = errMsg(e);
      // Exponential back-off, so a Supabase outage does not turn into a request storm.
      this.nextTryAt = Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(this.failures, 5));
      if (this.failures === 3) {
        const msg = `⚠️ Could not save the bot's data to Supabase ${this.failures} times in a row (${this.lastError}). It keeps trying, and the data is safe on this server's disk, but a restart now could lose recent changes.`;
        log(msg);
        this.opts.onTrouble?.(msg);
      }
      return false;
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (Date.now() >= this.nextTryAt) void this.flush();
    }, this.opts.pollMs ?? 2000);
    this.timer.unref?.();
  }

  /** Stop watching and make a last attempt to save everything. */
  async stop(): Promise<boolean> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (let i = 0; i < 3; i++) {
      if (await this.flush()) return true;
      await sleep(500);
    }
    return false;
  }

  status(): SyncStatus {
    return { lastUploadAt: this.lastUploadAt, pending: this.hydrated ? this.changed().length : 0, failures: this.failures, lastError: this.lastError };
  }
}
