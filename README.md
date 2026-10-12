# nft-sweeper-bot

A bot that finds free NFT mints that are trending on **Robinhood Chain** (chain ID 4663) and mints them.

## How it works

1. **Watch.** Every poll, it pulls mint events (`Transfer` / `TransferSingle` / `TransferBatch` out of `0x0`) for new blocks. It covers ERC-721 and ERC-1155, and ERC-20 mints are ignored. For each mint it loads the tx that caused it.
2. **Detect.** Over a sliding window of `WINDOW_BLOCKS`, a collection counts as **hot** when it meets both conditions:
   - at least `MIN_UNIQUE_MINTERS` different wallets and `MIN_MINT_TXS` txs minted it, and
   - **every** one of those mint txs sent `value == 0`. If one person pays, the collection is not treated as a free mint.
3. **Replay.** It takes the newest mint tx as a template and swaps the original minter's address in the calldata for yours, which handles `mint(address to, uint256 qty)` style calls. It then:
   - simulates with `eth_call`,
   - estimates gas and checks the worst-case cost against `MAX_GAS_COST_ETH`,
   - sends with `value: 0`.
4. **Verify.** It reads the receipt and confirms an NFT from that collection actually reached your wallet. If none did, the collection is marked bad and skipped from then on. Progress is saved in `state.json`.

## Safety rails

- `DRY_RUN=true` is the default. In that mode it detects and simulates but never sends.
- It never sends ETH. Every replayed tx has `value: 0`.
- It never replays `approve`, `setApprovalForAll`, `transfer*`, or `permit` calls, even when they emitted a mint.
- Each wallet sends at most `MAX_MINTS_PER_COLLECTION` txs per collection. Gas has a cap per tx, with an optional `maxFeePerGas` ceiling.
- **Use fresh burner wallets** that hold only gas ETH. Replaying a contract call you didn't write always carries some risk.

## Run

```bash
npm install
cp .env.example .env   # fill in PRIVATE_KEYS and ideally a paid RPC_URL
npm start              # dry run: watch the HOT / DRY-RUN logs
# when happy:
DRY_RUN=false npm start
```

`npm test` runs the unit tests. `npm run typecheck` runs the type checker.

## Tuning notes

- Robinhood Chain is an Arbitrum Orbit L2 with fast blocks, so `WINDOW_BLOCKS` covers a short span of time. Raise it to look further back.
- Lowering `MIN_UNIQUE_MINTERS` gets you in earlier but catches more junk and spam mints.
- Use `ALLOWLIST` to snipe one specific drop. Put its collection address there and set the thresholds low.
