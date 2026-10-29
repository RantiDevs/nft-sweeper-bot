import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHealthServer, startSelfPing } from "../src/health.js";
import { Lease } from "../src/persist/lease.js";
import { SupabaseKV } from "../src/persist/supabase.js";
import { DataSync } from "../src/persist/sync.js";

/** An in-memory stand-in for Supabase's REST API: the kv table and the two lock functions. */
function fakeSupabase() {
  const kv = new Map<string, { value: unknown; updated_at: string }>();
  const locks = new Map<string, { holder: string; expires: number }>();
  const control = { down: false, calls: 0 };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    control.calls++;
    if (control.down) return json({ message: "unavailable" }, 503);
    const headers = init.headers as Record<string, string>;
    if (headers.apikey !== "service-key") return json({ message: "bad key" }, 401);
    // A non-JWT secret key must not be sent as a bearer token (Supabase would reject it as an invalid JWT).
    if (headers.authorization !== undefined) return json({ message: "Invalid JWT" }, 401);
    const path = String(url).split("/rest/v1/")[1];
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (path.startsWith("kv?select")) return json([...kv].map(([key, v]) => ({ key, value: v.value, updated_at: v.updated_at })));
    if (path.startsWith("kv?on_conflict")) {
      for (const r of body) kv.set(r.key, { value: r.value, updated_at: r.updated_at });
      return new Response(null, { status: 201 });
    }
    if (path === "rpc/acquire_lock") {
      const cur = locks.get(body.p_name);
      if (!cur || cur.holder === body.p_holder || cur.expires < Date.now()) {
        locks.set(body.p_name, { holder: body.p_holder, expires: Date.now() + body.p_ttl_seconds * 1000 });
        return json(true);
      }
      return json(false);
    }
    if (path === "rpc/release_lock") {
      if (locks.get(body.p_name)?.holder === body.p_holder) locks.delete(body.p_name);
      return json(null, 204);
    }
    return json({ message: "unknown" }, 404);
  }) as unknown as typeof fetch;
  return { kv, locks, control, client: new SupabaseKV({ url: "https://abcdefgh.supabase.co", serviceKey: "service-key", fetchFn, retries: 0, timeoutMs: 2000 }) };
}

const tmp = () => mkdtempSync(join(tmpdir(), "persist-"));
function writeJson(dir: string, rel: string, value: unknown, mtimeMs?: number) {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, JSON.stringify(value));
  if (mtimeMs) utimesSync(abs, mtimeMs / 1000, mtimeMs / 1000);
}
const read = (dir: string, rel: string) => JSON.parse(readFileSync(join(dir, rel), "utf8"));

afterEach(() => vi.restoreAllMocks());

describe("API key styles", () => {
  it("sends a JWT service_role key as both apikey and bearer, and an sb_secret key as apikey only", async () => {
    const seen: Record<string, string>[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    await new SupabaseKV({ url: "https://abcdefgh.supabase.co", serviceKey: "eyJhbGciOi.payload.sig", fetchFn: f }).list();
    await new SupabaseKV({ url: "https://abcdefgh.supabase.co", serviceKey: "sb_secret_abc123", fetchFn: f }).list();
    expect(seen[0].authorization).toBe("Bearer eyJhbGciOi.payload.sig");
    expect(seen[1].apikey).toBe("sb_secret_abc123");
    expect(seen[1].authorization).toBeUndefined();
  });
});

describe("configuration", () => {
  it("is off without settings, and rejects half-set or malformed ones", () => {
    expect(SupabaseKV.fromEnv({})).toBeUndefined();
    expect(() => SupabaseKV.fromEnv({ SUPABASE_URL: "https://abcdefgh.supabase.co" })).toThrow(/both/);
    expect(() => SupabaseKV.fromEnv({ SUPABASE_URL: "http://evil.example", SUPABASE_SERVICE_KEY: "k" })).toThrow(/should look like/);
    expect(SupabaseKV.fromEnv({ SUPABASE_URL: "https://abcdefgh.supabase.co", SUPABASE_SERVICE_KEY: "k" })).toBeInstanceOf(SupabaseKV);
  });
});

describe("surviving a restart on a throwaway disk", () => {
  const users = { users: { "1": { id: 1, role: "admin", wallets: [{ address: "0xabc", enc: "v1.x.y.z" }], settings: { dryRun: true } } }, invites: {} };
  const state = { minted: {}, bad: {}, holdings: { "0xabc": [{ collection: "0xc1", tokenId: "7" }] }, gasSpentWei: "123", reverts: {} };

  it("brings every user, wallet and holding back onto an empty disk", async () => {
    const fake = fakeSupabase();
    // First life of the server: it creates data and uploads it.
    const dir1 = tmp();
    writeJson(dir1, "users.json", users);
    writeJson(dir1, "state/1.json", state);
    const first = new DataSync(dir1, fake.client);
    await first.hydrate();
    expect(fake.kv.size).toBe(2);

    // The server restarts with a brand-new empty disk.
    const dir2 = tmp();
    const second = new DataSync(dir2, fake.client);
    const r = await second.hydrate();
    expect(r.downloaded).toBe(2);
    expect(read(dir2, "users.json")).toEqual(users);
    expect(read(dir2, "state/1.json")).toEqual(state);
  });

  it("saves changes shortly after they are made, and only the files that changed", async () => {
    const fake = fakeSupabase();
    const dir = tmp();
    writeJson(dir, "users.json", users);
    writeJson(dir, "state/1.json", state);
    const sync = new DataSync(dir, fake.client);
    await sync.hydrate();
    fake.control.calls = 0;

    expect(await sync.flush()).toBe(true);
    expect(fake.control.calls).toBe(0); // nothing changed: no request

    writeJson(dir, "state/1.json", { ...state, gasSpentWei: "999" }, Date.now() + 5000);
    expect(sync.status().pending).toBe(1);
    await sync.flush();
    expect((fake.kv.get("state/1.json")!.value as { gasSpentWei: string }).gasSpentWei).toBe("999");
    expect(sync.status().pending).toBe(0);
  });

  it("ignores temp files, backups and the metadata cache", async () => {
    const fake = fakeSupabase();
    const dir = tmp();
    writeJson(dir, "users.json", users);
    writeJson(dir, "users.json.tmp", { x: 1 });
    writeJson(dir, "users.json.bak", { x: 2 });
    writeJson(dir, "metadata/0xabc.json", { x: 3 });
    writeJson(dir, "state/1.json.tmp", { x: 4 });
    await new DataSync(dir, fake.client).hydrate();
    expect([...fake.kv.keys()]).toEqual(["users.json"]);
  });

  it("keeps the newer copy: a local change that never uploaded beats an older stored one", async () => {
    const fake = fakeSupabase();
    fake.kv.set("users.json", { value: { users: {}, invites: {}, old: true }, updated_at: new Date(Date.now() - 60_000).toISOString() });
    const dir = tmp();
    writeJson(dir, "users.json", users, Date.now()); // newer than the stored one
    await new DataSync(dir, fake.client).hydrate();
    expect(read(dir, "users.json")).toEqual(users);
    expect(fake.kv.get("users.json")!.value).toEqual(users);
  });

  it("takes the stored copy when it is newer than what is on disk", async () => {
    const fake = fakeSupabase();
    fake.kv.set("users.json", { value: users, updated_at: new Date().toISOString() });
    const dir = tmp();
    writeJson(dir, "users.json", { users: {}, invites: {} }, Date.now() - 600_000);
    await new DataSync(dir, fake.client).hydrate();
    expect(read(dir, "users.json")).toEqual(users);
  });
});

describe("when Supabase is down", () => {
  it("refuses to start rather than risk wiping the stored data with an empty folder", async () => {
    const fake = fakeSupabase();
    fake.kv.set("users.json", { value: { users: { "1": {} } }, updated_at: new Date().toISOString() });
    fake.control.down = true;
    const dir = tmp();
    const sync = new DataSync(dir, fake.client);
    await expect(sync.hydrate()).rejects.toThrow(/503/);
    expect(existsSync(join(dir, "users.json"))).toBe(false);
    fake.control.down = false;
    expect((fake.kv.get("users.json")!.value as { users: object }).users).toEqual({ "1": {} }); // untouched
  });

  it("keeps changes on disk, retries, warns once after three failures, and catches up on recovery", async () => {
    const fake = fakeSupabase();
    const dir = tmp();
    writeJson(dir, "users.json", { users: {}, invites: {} });
    const warnings: string[] = [];
    const sync = new DataSync(dir, fake.client, { onTrouble: (m) => warnings.push(m) });
    await sync.hydrate();

    fake.control.down = true;
    writeJson(dir, "users.json", { users: { "9": { id: 9 } }, invites: {} }, Date.now() + 5000);
    for (let i = 0; i < 4; i++) expect(await sync.flush()).toBe(false);
    expect(sync.status().failures).toBe(4);
    expect(sync.status().pending).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(read(dir, "users.json").users["9"]).toBeDefined(); // safe on disk

    fake.control.down = false;
    expect(await sync.flush()).toBe(true);
    expect((fake.kv.get("users.json")!.value as { users: Record<string, unknown> }).users["9"]).toBeDefined();
    expect(sync.status().failures).toBe(0);
  });
});

describe("only one copy runs at a time", () => {
  it("lets the first copy in, turns a second one away, and admits it once the first lets go", async () => {
    const fake = fakeSupabase();
    const a = new Lease(fake.client, "bot", 90);
    const b = new Lease(fake.client, "bot", 90);
    await a.acquire(1000, 10);
    await expect(b.acquire(100, 10)).rejects.toThrow(/another copy of the bot is already running/);
    await a.release();
    await b.acquire(1000, 10);
    await b.release();
  });

  it("admits a new copy after a crashed one's lock runs out", async () => {
    const fake = fakeSupabase();
    const crashed = new Lease(fake.client, "bot", 90);
    await crashed.acquire(1000, 10); // ... then the process dies without releasing
    const next = new Lease(fake.client, "bot", 90);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 91_000);
    await next.acquire(1000, 10);
  });

  it("tells a running copy when its lock has been taken, so it can stop", async () => {
    vi.useFakeTimers();
    const fake = fakeSupabase();
    const a = new Lease(fake.client, "bot", 3);
    await a.acquire(1000, 10);
    const lost = vi.fn();
    a.start(lost);
    fake.locks.set("bot", { holder: "someone-else", expires: Date.now() + 60_000 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(lost).toHaveBeenCalledWith(expect.stringMatching(/taken by another copy/));
    await a.release();
    vi.useRealTimers();
  });
});

describe("health endpoint and keep-awake ping", () => {
  it("answers /health with status and nothing sensitive, and 404 elsewhere", async () => {
    const server = await startHealthServer(0, () => ({ phase: "running", headBlock: 123, persistence: { enabled: true, pending: 0 } }));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, phase: "running", headBlock: 123 });
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/key|token|secret|0x[0-9a-f]{40}/i);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/admin`)).status).toBe(404);
    server.close();
  });

  it("keeps working if the status function throws", async () => {
    const server = await startHealthServer(0, () => {
      throw new Error("boom");
    });
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/health`);
    expect(res.status).toBe(200);
    server.close();
  });

  it("pings its own public address on a schedule", async () => {
    vi.useFakeTimers();
    const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response("ok"));
    const stop = startSelfPing("https://my-bot.onrender.com/", 600_000, f as never);
    await vi.advanceTimersByTimeAsync(1_300_000);
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[0][0]).toBe("https://my-bot.onrender.com/health");
    stop();
    vi.useRealTimers();
  });
});
