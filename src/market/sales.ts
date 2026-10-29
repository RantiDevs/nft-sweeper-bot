import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import { TRANSFER_TOPIC } from "../logs.js";
import { mapLimit } from "../util.js";

export interface Transfer {
  tokenId: string;
  from: Address;
  to: Address;
  block: bigint;
  tx: Hex;
}

export interface Sale extends Transfer {
  /** Price paid for this token in wei, or undefined when the payment could not be read. */
  priceWei?: bigint;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const topicAddr = (t: Hex): Address => getAddress(`0x${t.slice(26)}`);

type RawLog = { address: Address; topics: Hex[]; data: Hex; transactionHash: Hex; blockNumber: Hex };

async function getLogsAdaptive(
  client: PublicClient,
  params: { address: Address; topics: Hex[] },
  from: bigint,
  to: bigint,
): Promise<RawLog[]> {
  try {
    return (await client.request({
      method: "eth_getLogs",
      params: [{ ...params, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` } as never],
    })) as RawLog[];
  } catch (e) {
    if (to <= from) throw e;
    const mid = from + (to - from) / 2n;
    return [...(await getLogsAdaptive(client, params, from, mid)), ...(await getLogsAdaptive(client, params, mid + 1n, to))];
  }
}

/** Every ERC-721 transfer of the collection in [fromBlock, toBlock], mints included. */
export async function readTransfers(client: PublicClient, collection: Address, fromBlock: bigint, toBlock: bigint): Promise<Transfer[]> {
  const out: Transfer[] = [];
  const STEP = 200_000n;
  for (let start = fromBlock; start <= toBlock; start += STEP) {
    const end = start + STEP - 1n < toBlock ? start + STEP - 1n : toBlock;
    for (const l of await getLogsAdaptive(client, { address: collection, topics: [TRANSFER_TOPIC] }, start, end)) {
      if (l.topics.length !== 4) continue; // ERC-20 style transfer, not an NFT
      out.push({
        tokenId: BigInt(l.topics[3]).toString(),
        from: topicAddr(l.topics[1]),
        to: topicAddr(l.topics[2]),
        block: BigInt(l.blockNumber),
        tx: l.transactionHash,
      });
    }
  }
  return out;
}

/**
 * Turns transfers into priced sales. A transfer is a sale when its transaction carried
 * ETH (a marketplace buy, split evenly across the collection's tokens moved in that tx)
 * or, with `weth` set, when the buyer paid WETH (an accepted offer). Transfers with no
 * payment (mints, gifts, moves between your own wallets) are not sales.
 */
export async function pricedSales(
  client: PublicClient,
  transfers: Transfer[],
  opts: { weth?: Address; concurrency?: number } = {},
): Promise<Sale[]> {
  const moves = transfers.filter((t) => t.from !== ZERO_ADDRESS && t.to !== ZERO_ADDRESS);
  const byTx = new Map<Hex, Transfer[]>();
  for (const t of moves) byTx.set(t.tx, [...(byTx.get(t.tx) ?? []), t]);

  const sales: Sale[] = [];
  await mapLimit([...byTx], opts.concurrency ?? 10, async ([hash, group]) => {
    try {
      const tx = await client.getTransaction({ hash });
      let total = tx.value;
      if (total === 0n && opts.weth) {
        const receipt = await client.getTransactionReceipt({ hash });
        const buyers = new Set(group.map((g) => g.to));
        total = receipt.logs
          .filter((l) => l.address.toLowerCase() === opts.weth!.toLowerCase() && l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3)
          .filter((l) => buyers.has(topicAddr(l.topics[1] as Hex)))
          .reduce((a, l) => a + BigInt(l.data), 0n);
      }
      if (total === 0n) return;
      const each = total / BigInt(group.length);
      for (const g of group) sales.push({ ...g, priceWei: each });
    } catch {
      // A transaction we cannot read is skipped rather than guessed at.
    }
  });
  return sales.sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
}

/** Latest owner of each token according to the transfers (mints and moves). */
export function currentOwners(transfers: Transfer[]): Map<string, Address> {
  const owners = new Map<string, Address>();
  for (const t of [...transfers].sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0))) {
    if (t.to === ZERO_ADDRESS) owners.delete(t.tokenId);
    else owners.set(t.tokenId, t.to);
  }
  return owners;
}
