# Running the bot free, all day, on Render + Supabase

Everything here uses free plans. Nothing in this guide has been run on the real services; it is written from their documentation, so expect to adjust a screen name or two.

| Service | What it does | Free plan |
|---|---|---|
| **GitHub** | holds the code; Render deploys from it | free |
| **Render** | runs the bot (a free *web service*) | 750 hours a month, 512 MB memory, 0.1 CPU |
| **Supabase** | remembers users, wallets and state across restarts | 500 MB database |
| **cron-job.org** | pings the bot every 5 minutes so Render doesn't put it to sleep | free |
| **Alchemy** (optional) | fast RPC for simulating and sending | 30M units a month |
| **Telegram** | the bot itself | free |

## How it fits together

- Render's free disk is **wiped on every restart**. The bot keeps working in its normal data folder, and a background task copies each change to Supabase within a couple of seconds. On start it restores everything from Supabase first. The wallets inside are encrypted with your `MASTER_KEY`, which is never stored in Supabase.
- Render's free service **sleeps after 15 minutes without web traffic**. The bot listens on a web port (`/health`), and the pinger calls it every 5 minutes. The bot also pings itself every 10 minutes.
- A **lock in Supabase** makes sure only one copy runs at a time. A second copy (for example your PC while Render runs) refuses to start. During a Render redeploy the new copy waits up to 2.5 minutes for the old one to let go.

## Step 1: put the code on GitHub

Use a **private** repository. The code contains no secrets (`.env`, `data/` and backups are git-ignored), but there is no reason to publish it.

```powershell
cd "C:\Users\ranti\OneDrive\Documents\robinhoood NfT\_clone_tmp"
git add -A
git status          # check: no .env, no data/, no *.bak files appear
git commit -m "Render + Supabase deployment"
git push
```

## Step 2: Supabase

1. supabase.com → **New project** (free plan). Pick a region near your Render region. Save the database password somewhere; the bot does not need it.
2. **SQL Editor → New query**, paste the whole of `supabase/schema.sql`, **Run**. It should say "Success".
3. **Project Settings → API** (or "API Keys"):
   - copy the **Project URL** (`https://xxxx.supabase.co`) → this is `SUPABASE_URL`
   - copy the **secret / service_role** key → this is `SUPABASE_SERVICE_KEY`. If both a legacy `service_role` key (starts `eyJ`) and a new `sb_secret_…` key are offered, either is supported; try the `eyJ` one first if one fails.
   - Never use the `anon` / publishable key, and never put the secret key anywhere except Render's environment settings.

## Step 3: move your existing wallets into Supabase (once)

Your 8 wallets currently live only on your PC. To bring them along, run the bot on your PC **once** with Supabase configured so it uploads them:

1. Add `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` to your local `.env`.
2. Run `npm run tg`. You should see: `persistence: Supabase connected; restored 0 file(s) from it and saved 2 local file(s) to it`.
3. Stop it (Ctrl+C). In Supabase **Table Editor → kv** you should see rows `users.json` and `state/<your id>.json`.
4. Keep this PC copy **stopped** from now on. Render takes over.

(If you skip this step, Render starts with no users and you re-run `/newwallets`.)

## Step 4: Render

1. render.com → **New → Blueprint** → connect GitHub → pick your private repo. Render reads `render.yaml`.
2. It asks for the secret values. Use the same ones as your local `.env`:
   `TELEGRAM_BOT_TOKEN`, `ADMIN_IDS`, `MASTER_KEY` (**exactly the same as before**, or the wallets cannot be decrypted), `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `OPENSEA_API_KEY`, `ACTION_RPC_URLS`.
3. Create. The first build takes a few minutes. In the **Logs** you should see `persistence: Supabase connected …`, then `Telegram bot @… online`.
4. Open `https://<your-service>.onrender.com/health`. It should show `{"ok":true,"phase":"running",…}`.

## Step 5: keep it awake with cron-job.org

1. cron-job.org → create a free account → **Create cronjob**.
2. URL: `https://<your-service>.onrender.com/health`, schedule: **every 5 minutes**, method GET.
3. Turn on **notifications on failure**.
4. (Alternative: UptimeRobot, a 5-minute HTTP monitor on the same URL.)

## Checking it works

- Telegram: `/status` replies. `/wallets` lists your 8 wallets.
- **Restart test (do this once before trusting it):** Render dashboard → **Manual Deploy → Restart**. After a minute, `/wallets` should still show the same 8 addresses. If it shows none, stop and do not fund anything.
- Supabase **kv** table updates when you change a setting.

## Limits to know about

- **Free Render is small.** 0.1 CPU and 512 MB. Watching a chain that produces 10 blocks a second may be too heavy for 0.1 CPU. If the bot falls behind (the alert says "no chain progress"), raise `POLL_INTERVAL_MS` (try 500–1000) or upgrade the instance.
- **Mints are missed while it sleeps or restarts.** A cold start takes about a minute. The pinger keeps that rare, not impossible.
- **750 free hours** covers one always-on service for a 31-day month (744 hours). Don't run a second free service on the same account.
- **Supabase pauses free projects after about a week of no activity.** The bot touches it every 30 seconds (the lock), so this should not happen while the bot runs.
- **Only one copy at a time.** Do not run the bot on your PC while Render is running.
- **Back up `MASTER_KEY`** somewhere that is not Render or Supabase. Without it the stored wallets cannot be decrypted.
- If Supabase is unreachable at startup the bot **refuses to start** instead of risking overwriting your data with an empty folder. Render will keep retrying.
- Rotate any key you have pasted into a chat (Telegram token via @BotFather `/revoke`, Alchemy, OpenSea).
