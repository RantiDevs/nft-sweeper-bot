import { parseAbi, type Address, type PublicClient } from "viem";
import { isRevert } from "./util.js";

const abi = parseAbi(["function supportsInterface(bytes4) view returns (bool)"]);
const ERC721 = "0x80ac58cd";
const ERC1155 = "0xd9b67a26";

/**
 * True if the contract claims ERC-721 or ERC-1155 via ERC-165. Filters out
 * fake "NFT" events from contracts that only imitate Transfer logs.
 * A revert or empty return means "no"; an RPC failure throws so the caller
 * can retry instead of permanently blacklisting a real collection.
 */
export async function isNftContract(client: PublicClient, address: Address): Promise<boolean> {
  const check = async (id: `0x${string}`) => {
    try {
      return await client.readContract({ address, abi, functionName: "supportsInterface", args: [id] });
    } catch (e) {
      if (isRevert(e) || /returned no data|not a contract|decode/i.test(String((e as Error).message))) return false;
      throw e;
    }
  };
  const [a, b] = await Promise.all([check(ERC721), check(ERC1155)]);
  return a === true || b === true;
}
