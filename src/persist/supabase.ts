import { sleep } from "../util.js";

/**
 * Minimal Supabase client over its REST API (PostgREST), using fetch: no SDK to install.
 *
 * It uses the service-role key, which bypasses row-level security, so it must live only in the server's
 * environment. The tables have RLS switched on with no policies (see supabase/schema.sql), so the public
 * anon key can read nothing. Wallet keys are additionally encrypted with MASTER_KEY before they get here,
 * and MASTER_KEY is never stored in the database.
 */

export interface KvEntry {
  key: string;
  value: unknown;
  updatedAt: number;
}

export interface SupabaseOptions {
  url: string;
  serviceKey: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
}

export class SupabaseError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export class SupabaseKV {
  private base: string;
  private f: typeof fetch;

  constructor(private opts: SupabaseOptions) {
    this.base = opts.url.replace(/\/+$/, "");
    this.f = opts.fetchFn ?? fetch;
  }

  /** Reads SUPABASE_URL and SUPABASE_SERVICE_KEY; undefined when persistence is not configured. */
  static fromEnv(env: Record<string, string | undefined> = process.env): SupabaseKV | undefined {
    const url = env.SUPABASE_URL?.trim();
    const serviceKey = (env.SUPABASE_SERVICE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
    if (!url && !serviceKey) return undefined;
    if (!url || !serviceKey) throw new Error("Set both SUPABASE_URL and SUPABASE_SERVICE_KEY (or neither)");
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i.test(url)) {
      throw new Error("SUPABASE_URL should look like https://<project-ref>.supabase.co");
    }
    return new SupabaseKV({ url, serviceKey });
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const retries = this.opts.retries ?? 3;
    let last: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await this.f(`${this.base}/rest/v1/${path}`, {
          ...init,
          headers: {
            apikey: this.opts.serviceKey,
            // The older service_role key is a JWT and is also sent as a bearer token. The newer
            // "sb_secret_..." keys are not JWTs: Supabase wants them in the apikey header only.
            ...(this.opts.serviceKey.startsWith("eyJ") ? { authorization: `Bearer ${this.opts.serviceKey}` } : {}),
            "content-type": "application/json",
            ...(init.headers as Record<string, string> | undefined),
          },
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
        });
        // Server trouble and rate limits are worth retrying; a 4xx about our request is not.
        if (res.status >= 500 || res.status === 429) {
          last = new SupabaseError(`Supabase answered HTTP ${res.status}`, res.status);
        } else if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 200);
          throw new SupabaseError(`Supabase HTTP ${res.status}: ${detail}`, res.status);
        } else {
          return res;
        }
      } catch (e) {
        if (e instanceof SupabaseError && e.status && e.status < 500 && e.status !== 429) throw e;
        last = e;
      }
      if (attempt < retries) await sleep(400 * 2 ** attempt);
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  /** Every stored document. */
  async list(): Promise<KvEntry[]> {
    const res = await this.request("kv?select=key,value,updated_at", { method: "GET" });
    const rows = (await res.json()) as { key: string; value: unknown; updated_at: string }[];
    return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: Date.parse(r.updated_at) }));
  }

  /** Insert or replace documents, in one request. */
  async put(entries: { key: string; value: unknown; updatedAt?: number }[]): Promise<void> {
    if (entries.length === 0) return;
    await this.request("kv?on_conflict=key", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(entries.map((e) => ({ key: e.key, value: e.value, updated_at: new Date(e.updatedAt ?? Date.now()).toISOString() }))),
    });
  }

  /** Atomically take or renew a named lock. True if `holder` now owns it. */
  async acquire(name: string, holder: string, ttlSeconds: number): Promise<boolean> {
    const res = await this.request("rpc/acquire_lock", {
      method: "POST",
      body: JSON.stringify({ p_name: name, p_holder: holder, p_ttl_seconds: ttlSeconds }),
    });
    return (await res.json()) === true;
  }

  async release(name: string, holder: string): Promise<void> {
    await this.request("rpc/release_lock", { method: "POST", body: JSON.stringify({ p_name: name, p_holder: holder }) });
  }
}
