# nft-sweeper-bot

A multi-wallet bot that finds **free NFT mints trending on Robinhood Chain** (chain ID 4663) and mints them from every wallet you control. It's built to keep running through RPC failures, gas spikes, stuck transactions and trap contracts.

## How it works

```
 new blocks ─▶ mint logs ─▶ detector ─▶ hot collection ─▶ scout wallet ─▶ all wallets (parallel)
              (721/1155)   (sliding     (N distinct        (simulate,     (local nonces, budget,
                            window)      free minters)      send, verify)   retries, fee bumps)
```

1. **Watch.** Every poll it reads ERC-721 `Transfer` and ERC-1155 `TransferSingle`/`Batch` events coming from `0x0` (ERC-20 mints are ignored), then loads the transaction behind each one. If the RPC rejects a block range as too large, the bot splits it automatically.
2. **Detect.** A collection is **hot** when at least `MIN_UNIQUE_MINTERS` distinct wallets and `MIN_MINT_TXS` transactions minted it within `WINDOW_BLOCKS`, **and every one of those mints was free**. One paid mint disqualifies the collection.
3. **Pick a template.** Mint transactions are grouped into call patterns: the same contract and calldata, with the minter's own address masked out. Patterns are ranked by how many distinct wallets used them, and the bot tries the top 3 in order. Whichever works is reused for the remaining wallets.
4. **Scout, then swarm.** One wallet goes first. It simulates the call (`estimateGas`), checks costs, sends, then reads the receipt to confirm an NFT actually reached it. Only after that do the other wallets fire, in parallel (`WALLET_CONCURRENCY`). A trap or broken mint therefore costs **one** transaction, not one per wallet.
5. **Record.** Each minted token ID is saved in `state.json`, so `npm run collect` can move everything to your vault.

## Robustness features

| Problem | What the bot does |
|---|---|
| RPC dies or lags | Several `RPC_URLS` with latency-ranked failover. Every call has a timeout and retries, and each mint step has a hard deadline, so a hung call can't freeze a wallet. |
| RPC flakes mid-round | RPC errors are kept separate from contract reverts. Wallets that hit a temporary error retry within the same round with backoff, and a flaky RPC never blacklists a real collection. |
| Base fee spikes during a hot mint | Fees are quoted at `baseFee × BASE_FEE_MULTIPLIER + tip` and refreshed every 2 seconds. You pay only the actual base fee plus tip. |
| Transaction stuck anyway | It is replaced with the same nonce and a fee at least 30% higher, but only while the new worst-case cost stays within your per-transaction cap. |
| Many wallets, many collections at once | Each wallet has its own nonce manager, so wallets fire back-to-back without waiting for confirmations. A nonce is only used up when a send succeeds, and stale nonces are resynced and retried. |
| Runaway gas | `MAX_GAS_COST_ETH` caps each transaction. `TOTAL_GAS_BUDGET_ETH` is a global kill switch that reserves the worst case before each send, so 25 wallets firing together can't overshoot it. The budget is saved across restarts. |
| Wallet out of gas | It checks the balance before sending and skips that wallet. Startup flags any wallets running low. |
| Trap contracts (token goes to someone else) | The receipt is checked, and if no NFT reached your wallet the collection is blacklisted after one transaction. |
| Fake NFTs (contracts that only emit look-alike events) | ERC-165 `supportsInterface` check (721/1155). |
| Mint transactions that are really approvals | `approve`, `setApprovalForAll`, `transfer*` and `permit` calls are never replayed. |
| Crash or Ctrl-C | State is written atomically (temp file, then rename). On shutdown the bot waits for in-flight mints to finish. |
| ETH sent with a mint | Never: every replayed transaction has `value: 0`. |

## Setup

```bash
npm install
cp .env.example .env

# 1. Make burner wallets (written with permissions 600; back the file up, never commit it)
npm run wallets:new -- 25            # writes wallets.txt → set KEYS_FILE=wallets.txt

# 2. Fund them from one wallet: set FUNDER_PRIVATE_KEY and FUND_TARGET_ETH in .env
npm run fund                         # preview
npm run fund -- --yes                # send

npm run balances                     # ETH, tx count, uncollected NFTs per wallet

# 3. Run: dry run first, then live
npm start
DRY_RUN=false npm start

# 4. Collect the bag and recover gas
npm run collect -- --yes             # every minted NFT → VAULT_ADDRESS
npm run recover -- --yes             # leftover ETH → funder (or pass an address)
```

Every command that moves funds is a preview unless you add `--yes`.

### Sniping a specific drop

Put the collection address in `ALLOWLIST`. Allowlisted collections use `ALLOWLIST_MIN_*` (default 1), so the bot fires on the first mint it sees instead of waiting for a crowd. When `ALLOWLIST` is set, it mints only those collections.

### Tuning

- **Speed comes from the RPC.** Robinhood Chain is an Arbitrum Orbit L2. The sequencer orders transactions first come, first served and there's no public mempool to front-run, so the fastest transaction is the one reaching the sequencer first. Use paid, low-latency endpoints in `RPC_URLS`, located near the sequencer.
- Lowering `MIN_UNIQUE_MINTERS` gets you in earlier, but catches more junk.
- Robinhood Chain makes about 10 blocks per second, so `WINDOW_BLOCKS=6000` is about 10 minutes.

## Tests

```bash
npm test          # 80+ tests, including full runs on a local chain
npm run typecheck
```

Besides the unit tests, `test/e2e.test.ts` runs the whole engine against an in-process EVM (Ganache). It compiles real Solidity contracts from `test/fixtures/Nfts.sol` and checks that:
- 12 wallets each sweep a free `mint(address,uint256)` collection and a free `claim()` collection, and the recorded token IDs match on-chain ownership;
- a paid mint is ignored;
- a trap mint costs exactly one transaction and is then blacklisted;
- a fake NFT is rejected by ERC-165;
- a second pass sends nothing;
- dry-run sends nothing;
- the global gas budget stops the swarm.

## Disclaimer

Replaying other people's contract calls carries risk. Use burner wallets that hold only gas money, start in dry-run, and keep the gas caps tight.

## Sweep mode: mint every new legit free NFT

By default (`SWEEP_ALL=true`) the bot acts on **any new collection whose observed mints were all free**, instead of waiting for a crowd (`SWEEP_ALL=false` restores "hot only"). Because there is no crowd to vouch for a collection, every candidate goes through a safety screen **before any gas is spent**:

| Check | Catches |
|---|---|
| Free only | A single paid mint disqualifies the collection |
| ERC-165 (721/1155) | Contracts that only fake NFT `Transfer` events |
| Real contract code | Mints aimed at empty/non-contract addresses |
| Source verified (`REQUIRE_VERIFIED=true`) | Unreviewable contracts. New contracts verified late are re-checked, not blacklisted |
| Trace screen (`VET_TRACE`, needs an RPC with `debug_traceCall`) | Mints that call `approve`/`setApprovalForAll`/`transfer*`/`permit`, move ETH, or self-destruct |
| Scout wallet + receipt check | Mints that don't deliver the token to you: one wasted tx, then blocked |
| Two on-chain reverts | Stops paying gas for a collection that keeps failing |

No automated check can prove a collection is legitimate. The real safety comes from how the wallets are used: they hold only gas ETH, the bot never approves anything, and a mint never carries ETH, so a malicious contract can cost you at most the gas of one transaction.

## Gas costs

Measured by Bitquery on Robinhood Chain (Aug-Sep 2026): the base fee has a floor of 0.02 gwei, and at that floor a plain ETH transfer cost about $0.001 and the median transaction about $0.006. From Aug 24 trading bots pushed fees about 23x higher for roughly two weeks (median $0.20), then they fell back. Every transaction on the chain pays the same per-gas price, so your mints pay a spike too.

A mint uses roughly 4-7x the gas of a plain transfer, so expect **about $0.004-0.007 per mint at the floor** (about $4-7 per 1000 mints) and 20x+ that during a spike. Check your first dry run for the real figure.

How the bot keeps this low:
- `MAX_BASE_FEE_GWEI=0.05` (default): it pauses minting while the base fee is above that, so you don't pay spike prices. Set `off` to disable.
- no tip (Orbit orders first-come-first-served, so a tip buys nothing)
- it simulates before sending, picks the cheapest working mint call, and blocks collections that revert on-chain twice
- trap mints are rejected by a free simulation (`eth_simulateV1`, when the RPC supports it) instead of costing a transaction
- `MAX_WALLETS_PER_COLLECTION` (e.g. 5 of 30 wallets mint each collection: about 6x cheaper), `MAX_GAS_COST_ETH` per mint, `TOTAL_GAS_BUDGET_ETH` as a hard stop
- not collecting NFTs you don't want (each transfer costs gas too)

## What the NFTs are worth, and what to do with them (`npm run plan`, `/plan`)

The bot values every NFT it holds and decides on its own. You don't pick prices.

1. **Traits** are read from each token's metadata (`attributes`, on-chain or IPFS/Arweave/HTTP, fetched safely: private addresses are refused), and every token is ranked against the whole collection (or a deterministic sample of big ones). Unrevealed collections and tokens without traits are marked WAIT.
2. **Market**: sales are read from the chain (a transfer in a transaction that carried ETH, or WETH for accepted offers). Wash trades are removed first: self-trades, tokens returning to a previous seller, and wallet pairs trading with each other 3+ times. If `OPENSEA_API_KEY` is set, OpenSea's floor is added and the lower of the two is used.
3. **Value** = floor x rarity premium. The premium is flat for the commoner half of a collection and grows toward the top (shape from Mekacher et al. 2022: about +195% for the rarest decile). It is a literature default, not fitted to this chain.
4. **Collection health** (0-100) comes from recent sales, different buyers, holder spread, whale concentration, price trend and wash share. It is ACTIVE, THIN, STALLED, NO_MARKET or DEAD.
5. **Decision**: HOLD only the rarest ~15% of an ACTIVE collection with a high score and real value; SELL the rest at about the floor (a bit under it if the market is thin); DEAD for collections that never traded or tokens worth pennies; WAIT until there is a market.

`PLAN_MODE=tiers` (or `/tiers ...` in Telegram) uses fixed price tiers instead. Nothing here predicts the future: most free mints never trade, so re-run the plan as the market develops. The bot does not list anything for you, because listing needs approvals and these wallets never approve.

## Dollars everywhere

All amounts the bot shows (balances, gas, budgets, plan values and prices) are in dollars, converted at a live ETH price: the median of Coinbase, Kraken and CoinGecko, refreshed every minute, so one wrong feed cannot move it. If every feed is unreachable it keeps the last good price, then falls back to `ETH_USD` if you set it. Amounts you type are dollars too: `/set budget 2` or `/set maxgas $0.005`; add `eth` for ETH, e.g. `/set budget 0.001eth`. Gas is still paid in ETH, so a dollar limit is converted to ETH when you set it and is not re-converted if the price moves later.

## Getting an OpenSea API key

The key is optional: without it the bot prices from on-chain sales only. With it the bot also reads OpenSea's floor price and owner counts.

1. Sign in at opensea.io with your wallet (verify your email if asked).
2. Profile menu > **Settings** > **Developer**.
3. Click **Get access**, fill in the organization name, website and intended use, pass the reCAPTCHA, and click **Create key**. You can have up to three keys.
4. Put it in `.env` as `OPENSEA_API_KEY=...` and keep it private.

OpenSea also offers an instant free-tier key from a single `POST https://api.opensea.io/api/v2/auth/keys`, with lower rate limits and a short expiry (days, not months), which is enough to try it. Their docs are at docs.opensea.io/reference/api-keys and may have changed. Whether OpenSea's API lists Robinhood Chain is something I could not confirm: the bot looks the chain up itself and falls back to on-chain sales if it is not there.

## Speed

The bot is built around round trips, because on a public RPC each one takes about half a second.

- **Discovery:** one batched request per tick fetches the head, the next blocks with their transactions, and the mint logs. It polls every 100 ms and loops straight away when it finds new blocks. With `RPC_WS_URL` set, new blocks wake it the moment they are produced.
- **Checks:** the NFT check, code check, trace and the free delivery simulation run at the same time.
- **Minting:** when the free simulation (`eth_simulateV1`) proves a mint delivers, every wallet starts at once and reuses the first wallet's gas estimate. The log shows `FIRST TX SENT ... ms after the bot first saw this collection mint` so you can measure it.
- **Drops announced ahead of time:** see below.

What limits speed now is the distance to the RPC, not the code. Run the bot on a small cloud server near your RPC provider's region and use a paid RPC.

### Drops announced ahead of time (`DROPS=true`)

Many drops on Robinhood Chain go through OpenSea's SeaDrop contract. The creator announces a drop on-chain before it opens: a `PublicDropUpdated` event gives the collection, the mint price and the start and end time. The bot follows these announcements:

1. A **free** drop starting within `DROP_LEAD_HOURS` is armed: fee recipient resolved, NFT and code checks done, wallet balances loaded. **Paid drops are never armed.**
2. It then waits without using the network, and starts checking about 1.5 seconds before the start.
3. It checks with a free simulation: would the mint succeed right now and put the token in my wallet? The moment that is true, every wallet mints in parallel.
4. If the creator changes the terms, the old wait is cancelled and replaced. Re-announcing identical terms does nothing.

The SeaDrop interface was checked against OpenSea's source and against the live contract on the chain. This covers drops that go through SeaDrop only. Other drop contracts are still caught by the normal watcher, after their first mint. New contracts deployed directly are noticed at creation and their NFT check is started early, but contracts created through factories are not.

### Where to get a WebSocket endpoint and a fast RPC

The free public RPC (`rpc.mainnet.chain.robinhood.com`) has no WebSocket and is rate limited. For speed, create a free account at a provider that lists Robinhood Chain and copy its `wss://` URL into `RPC_WS_URL` and its `https://` URL into `RPC_URLS`. Providers that advertise the chain: Alchemy, QuickNode, Chainstack, Dwellir, dRPC, GetBlock. I could not measure their latency and could not confirm which of them offer WebSocket on this chain's free plan, so confirm that on the provider's chain page. Note that this chain produces about 10 blocks per second, so a WebSocket stream of every block uses a lot of a free plan's allowance; the bot still works without it.

### Free places to run the bot 24/7

Oracle Cloud's Always Free tier is the strongest (ARM VM, but capacity is limited, the allowance was reported reduced in 2026, and idle instances can be reclaimed). Google Cloud's `e2-micro` is small but permanently free in certain US regions. Fly.io and Railway are cheap, not free. Confirm current terms before relying on any of them. Pick a region close to your RPC provider.

## Telegram bot (multi-user)

```bash
npm run tg:genkey          # prints MASTER_KEY; back it up
# fill TELEGRAM_BOT_TOKEN, ADMIN_IDS, MASTER_KEY in .env
npm run tg
```

One shared chain watcher serves every user; each user has their own wallets (private keys AES-256-GCM encrypted on disk), limits, gas budget and state. New users start in dry-run. Access is by invite (`/invite` as admin). Users: `/newwallets`, `/deposit`, `/wallets`, `/status`, `/live`, `/dry`, `/mode sweep|hot`, `/set ...`, `/allow`, `/deny`, `/nfts`, `/vault`, `/collect`, `/recover`, `/export`. Admins: `/invite`, `/users`, `/ban`, `/unban`, `/stats`, `/broadcast`.

Operator notes:
- The wallets are **custodial**: your server holds the keys. Tell users to only fund what they can lose and to `/collect` regularly.
- Telegram bots are not end-to-end encrypted. `/export` shows keys in chat (auto-deleted); set `ALLOW_EXPORT=false` to disable it.
- Per-user limits are capped by `CEILING_*`; `MAX_CONCURRENT_MINTS` protects the shared RPC.
- Losing `MASTER_KEY` means losing every stored wallet. `data/users.json.bak` keeps the previous version of the user file.
- The bot alerts admins when the chain stops advancing or a block range keeps failing.
