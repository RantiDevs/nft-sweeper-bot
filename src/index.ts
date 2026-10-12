import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainFor } from "./chain.js";
import { loadConfig } from "./config.js";
import { MintDetector, type MintObservation } from "./detector.js";
import {
  parseMintLog,
  TRANSFER_BATCH_TOPIC,
  TRANSFER_SINGLE_TOPIC,
  TRANSFER_TOPIC,
  ZERO_TOPIC,
} from "./logs.js";
import { mintFor, type Wallet } from "./minter.js";
import { State } from "./state.js";

const MAX_LOG_RANGE = 500n;
const RETRY_AFTER_MS = 60_000;
const TX_FETCH_BATCH = 20;

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

const cfg = loadConfig();
const chain = chainFor(cfg.chainId);
const transport = http(cfg.rpcUrl);
const publicClient = createPublicClient({ chain, transport }) as PublicClient;
const wallets: Wallet[] = cfg.privateKeys.map((pk) => {
  const account = privateKeyToAccount(pk);
  return { account, client: createWalletClient({ account, chain, transport }) };
});
const ourAddresses = new Set<Address>(wallets.map((w) => w.account.address));
const state = new State(cfg.stateFile);
const detector = new MintDetector(cfg);
const lastAttempt = new Map<string, number>();

type RpcLog = { address: Address; topics: Hex[]; transactionHash: Hex; blockNumber: Hex };

async function getMintLogs(fromBlock: bigint, toBlock: bigint): Promise<RpcLog[]> {
  const range = { fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` };
  const query = (topics: (Hex | Hex[] | null)[]) =>
    publicClient.request({ method: "eth_getLogs", params: [{ ...range, topics } as never] }) as Promise<RpcLog[]>;
  const [erc721, erc1155] = await Promise.all([
    query([TRANSFER_TOPIC, ZERO_TOPIC]),
    query([[TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC], null, ZERO_TOPIC]),
  ]);
  return [...erc721, ...erc1155];
}

async function ingest(fromBlock: bigint, toBlock: bigint): Promise<void> {
  const logs = await getMintLogs(fromBlock, toBlock);
  const collectionsByTx = new Map<Hex, Set<Address>>();
  for (const l of logs) {
    const m = parseMintLog({ ...l, blockNumber: BigInt(l.blockNumber) } as never);
    if (!m) continue;
    if (cfg.denylist.has(m.collection) || state.isBad(m.collection)) continue;
    if (cfg.allowlist.size && !cfg.allowlist.has(m.collection)) continue;
    const set = collectionsByTx.get(l.transactionHash) ?? new Set();
    set.add(m.collection);
    collectionsByTx.set(l.transactionHash, set);
  }

  const hashes = [...collectionsByTx.keys()];
  for (let i = 0; i < hashes.length; i += TX_FETCH_BATCH) {
    const batch = hashes.slice(i, i + TX_FETCH_BATCH);
    const txs = await Promise.all(
      batch.map((hash) => publicClient.getTransaction({ hash }).catch(() => null)),
    );
    for (const tx of txs) {
      if (!tx || !tx.to || tx.blockNumber === null) continue;
      const minter = getAddress(tx.from);
      if (ourAddresses.has(minter)) continue;
      for (const collection of collectionsByTx.get(tx.hash)!) {
        const obs: MintObservation = {
          collection,
          txHash: tx.hash,
          blockNumber: tx.blockNumber,
          minter,
          target: getAddress(tx.to),
          input: tx.input,
          value: tx.value,
        };
        detector.add(obs);
      }
    }
  }
}

async function act(): Promise<void> {
  for (const hot of detector.hot()) {
    if (state.isBad(hot.collection)) continue;
    const targets = wallets.length ? wallets : [null];
    for (const wallet of targets) {
      const key = `${hot.collection}:${wallet?.account.address ?? "watch"}`;
      const last = lastAttempt.get(key) ?? 0;
      if (Date.now() - last < RETRY_AFTER_MS) continue;
      lastAttempt.set(key, Date.now());

      const tag = `${hot.collection} (${hot.uniqueMinters} minters / ${hot.mintTxs} txs)`;
      if (!wallet) {
        log(`HOT ${tag} via ${hot.template.target} selector ${hot.template.input.slice(0, 10)} [no wallet configured]`);
        continue;
      }
      const res = await mintFor(hot, wallet, publicClient, cfg, state);
      log(`${res.status.toUpperCase()} ${tag} wallet=${wallet.account.address}`, res);
    }
  }
}

async function main(): Promise<void> {
  log(
    `Robinhood Chain free-mint sweeper | chain ${chain.id} | wallets ${wallets.length} | ` +
      `${cfg.dryRun ? "DRY RUN (set DRY_RUN=false to send txs)" : "LIVE"}`,
  );
  let head = await publicClient.getBlockNumber();
  let cursor = head > BigInt(cfg.windowBlocks) ? head - BigInt(cfg.windowBlocks) : 0n;

  for (;;) {
    try {
      head = await publicClient.getBlockNumber();
      while (cursor <= head) {
        const to = cursor + MAX_LOG_RANGE - 1n < head ? cursor + MAX_LOG_RANGE - 1n : head;
        await ingest(cursor, to);
        cursor = to + 1n;
      }
      detector.prune(head);
      await act();
    } catch (e) {
      log("loop error:", e instanceof Error ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
