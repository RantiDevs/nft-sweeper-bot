import { getAddress, type Address, type Hex, type Log } from "viem";

export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;
export const TRANSFER_SINGLE_TOPIC =
  "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62" as const;
export const TRANSFER_BATCH_TOPIC =
  "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb" as const;
export const ZERO_TOPIC = `0x${"0".repeat(64)}` as const;

type RawLog = Pick<Log, "address" | "topics" | "transactionHash" | "blockNumber">;

function topicToAddress(t: Hex): Address {
  return getAddress(`0x${t.slice(26)}`);
}

/**
 * Returns `{ collection, to }` when the log is an NFT mint (ERC721 Transfer or
 * ERC1155 TransferSingle/Batch out of the zero address), otherwise null.
 * ERC721 Transfer indexes tokenId (4 topics); ERC20 Transfer does not (3 topics),
 * which is how fungible mints are excluded.
 */
export function parseMintLog(log: RawLog): { collection: Address; to: Address } | null {
  const [sig, a, b, c] = log.topics as Hex[];
  if (sig === TRANSFER_TOPIC && log.topics.length === 4 && a === ZERO_TOPIC) {
    return { collection: getAddress(log.address), to: topicToAddress(b) };
  }
  if ((sig === TRANSFER_SINGLE_TOPIC || sig === TRANSFER_BATCH_TOPIC) && b === ZERO_TOPIC && c) {
    return { collection: getAddress(log.address), to: topicToAddress(c) };
  }
  return null;
}
