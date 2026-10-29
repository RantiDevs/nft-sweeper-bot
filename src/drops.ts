import {
  decodeAbiParameters,
  encodeFunctionData,
  getAddress,
  parseAbi,
  toEventSelector,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

/**
 * Early warning for drops. Many NFT drops on Robinhood Chain run through OpenSea's SeaDrop
 * contract, and the creator announces the drop on-chain BEFORE it opens: a
 * `PublicDropUpdated` event states the collection, the mint price and the start and end
 * time. So the bot can learn "collection X mints free from time T" minutes or hours ahead,
 * wait quietly, and send the instant it opens, instead of discovering the mint only after
 * someone else has minted.
 *
 * Interface verified against ProjectOpenSea/seadrop (ISeaDrop.sol, SeaDropStructs.sol,
 * SeaDropErrorsAndEvents.sol) and against the live contract on Robinhood Chain.
 */

/** SeaDrop is deployed at the same address on every chain. */
export const SEADROP_ADDRESS = getAddress("0x00005ea00ac477b1030ce78506496e8c2de24bf5");

/** The fee recipient OpenSea's own drops allow (seen on the live chain). Used only when a drop does not restrict recipients. */
export const DEFAULT_FEE_RECIPIENT = getAddress("0x0000a26b00c1f0df003000390027140000faa719");

export const PUBLIC_DROP_UPDATED = toEventSelector("PublicDropUpdated(address,(uint80,uint48,uint48,uint16,uint16,bool))");

export const seaDropAbi = parseAbi([
  "struct PublicDrop { uint80 mintPrice; uint48 startTime; uint48 endTime; uint16 maxTotalMintableByWallet; uint16 feeBps; bool restrictFeeRecipients; }",
  "function getPublicDrop(address nftContract) view returns (PublicDrop)",
  "function getAllowedFeeRecipients(address nftContract) view returns (address[])",
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable",
]);

export interface Drop {
  nft: Address;
  seaDrop: Address;
  /** Wei per token. 0 means free. */
  mintPrice: bigint;
  /** Unix seconds. */
  startTime: number;
  endTime: number;
  maxPerWallet: number;
  feeBps: number;
  restrictFeeRecipients: boolean;
  block: bigint;
}

const tupleParam = [
  {
    type: "tuple",
    components: [
      { name: "mintPrice", type: "uint80" },
      { name: "startTime", type: "uint48" },
      { name: "endTime", type: "uint48" },
      { name: "maxTotalMintableByWallet", type: "uint16" },
      { name: "feeBps", type: "uint16" },
      { name: "restrictFeeRecipients", type: "bool" },
    ],
  },
] as const;

/** Decodes a PublicDropUpdated log; returns null for anything malformed. */
export function decodeDrop(log: { address: Address; topics: readonly Hex[]; data: Hex; blockNumber: Hex | bigint }): Drop | null {
  try {
    if (log.topics[0] !== PUBLIC_DROP_UPDATED || log.topics.length < 2) return null;
    const [d] = decodeAbiParameters(tupleParam, log.data);
    return {
      nft: getAddress(`0x${log.topics[1].slice(26)}`),
      seaDrop: getAddress(log.address),
      mintPrice: d.mintPrice,
      startTime: Number(d.startTime),
      endTime: Number(d.endTime),
      maxPerWallet: d.maxTotalMintableByWallet,
      feeBps: d.feeBps,
      restrictFeeRecipients: d.restrictFeeRecipients,
      block: BigInt(log.blockNumber),
    };
  } catch {
    return null;
  }
}

/**
 * Worth arming: free, not already over, sane times, and starting within `leadSec`.
 * A paid drop is never armed: this bot sends no ETH with a mint.
 */
export function isArmable(d: Drop, nowSec: number, leadSec: number): boolean {
  return (
    d.mintPrice === 0n &&
    d.maxPerWallet > 0 &&
    d.endTime > d.startTime &&
    d.endTime > nowSec &&
    d.startTime <= nowSec + leadSec
  );
}

/** What changed matters: a re-announcement with the same terms is not news. */
export const dropSignature = (d: Drop) => `${d.mintPrice}:${d.startTime}:${d.endTime}:${d.maxPerWallet}:${d.restrictFeeRecipients}`;

/** The recipient to pass to mintPublic: one the drop allows, or OpenSea's when unrestricted. */
export async function resolveFeeRecipient(client: PublicClient, d: Drop): Promise<Address | undefined> {
  if (!d.restrictFeeRecipients) return DEFAULT_FEE_RECIPIENT;
  const allowed = await client.readContract({ address: d.seaDrop, abi: seaDropAbi, functionName: "getAllowedFeeRecipients", args: [d.nft] });
  return allowed[0];
}

/** mintPublic(nft, feeRecipient, minterIfNotPayer = 0, quantity): the NFT goes to whoever sends it. */
export function mintCalldata(d: Drop, feeRecipient: Address, quantity: number): Hex {
  const qty = Math.max(1, Math.min(quantity, d.maxPerWallet));
  return encodeFunctionData({ abi: seaDropAbi, functionName: "mintPublic", args: [d.nft, feeRecipient, zeroAddress, BigInt(qty)] });
}
