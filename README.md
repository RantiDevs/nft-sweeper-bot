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
- Blocks are fast, so `WINDOW_BLOCKS=1200` only covers a few minutes.

## Tests

```bash
npm test          # 39 tests
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
