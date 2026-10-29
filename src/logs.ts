import { decodeAbiParameters, getAddress, type Address, type Hex } from "viem";

export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;
export const TRANSFER_SINGLE_TOPIC =
  "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62" as const;
export const TRANSFER_BATCH_TOPIC =
  "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb" as const;
export const ZERO_ADDRESS_STR = "0x0000000000000000000000000000000000000000" as const;
export const ZERO_TOPIC = `0x${"0".repeat(64)}` as const;

export type Standard = "erc721" | "erc1155";

export interface MintedToken {
  id: bigint;
  amount: bigint;
}

export interface ParsedMint {
  collection: Address;
  to: Address;
  standard: Standard;
  tokens: MintedToken[];
}

interface RawLog {
  address: Address;
  topics: readonly Hex[] | Hex[];
  data?: Hex;
}

function topicToAddress(t: Hex): Address {
  return getAddress(`0x${t.slice(26)}`);
}

/**
 * Returns the mint when the log is an NFT mint (ERC-721 Transfer or ERC-1155
 * TransferSingle/Batch out of the zero address), otherwise null.
 * ERC-721 Transfer indexes tokenId (4 topics); ERC-20 Transfer does not (3
 * topics), which is how fungible mints are excluded. Malformed logs return null.
 */
export function parseMintLog(log: RawLog): ParsedMint | null {
  const [sig, a, b, c] = log.topics as Hex[];
  try {
    if (sig === TRANSFER_TOPIC && log.topics.length === 4 && a === ZERO_TOPIC) {
      return {
        collection: getAddress(log.address),
        to: topicToAddress(b),
        standard: "erc721",
        tokens: [{ id: BigInt(log.topics[3]), amount: 1n }],
      };
    }
    if (sig === TRANSFER_SINGLE_TOPIC && b === ZERO_TOPIC && c) {
      const tokens = log.data && log.data.length >= 130
        ? (() => {
            const [id, amount] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], log.data);
            return [{ id, amount }];
          })()
        : [];
      return { collection: getAddress(log.address), to: topicToAddress(c), standard: "erc1155", tokens };
    }
    if (sig === TRANSFER_BATCH_TOPIC && b === ZERO_TOPIC && c) {
      const tokens = log.data && log.data !== "0x"
        ? (() => {
            const [ids, amounts] = decodeAbiParameters([{ type: "uint256[]" }, { type: "uint256[]" }], log.data);
            return ids.map((id, i) => ({ id, amount: amounts[i] ?? 0n }));
          })()
        : [];
      return { collection: getAddress(log.address), to: topicToAddress(c), standard: "erc1155", tokens };
    }
  } catch {
    return null;
  }
  return null;
}
