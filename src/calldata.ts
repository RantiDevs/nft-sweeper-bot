import { type Address, type Hex } from "viem";

/**
 * Selectors we never replay even if the tx happened to emit a mint: they hand
 * out control of assets the wallet holds.
 */
export const BLOCKED_SELECTORS = new Set<string>([
  "0x095ea7b3", // approve(address,uint256)
  "0xa22cb465", // setApprovalForAll(address,bool)
  "0xa9059cbb", // transfer(address,uint256)
  "0x23b872dd", // transferFrom(address,address,uint256)
  "0x42842e0e", // safeTransferFrom(address,address,uint256)
  "0xb88d4fde", // safeTransferFrom(address,address,uint256,bytes)
  "0xf242432a", // safeTransferFrom (ERC1155)
  "0x2eb2c2d6", // safeBatchTransferFrom (ERC1155)
  "0xd505accf", // permit
  "0x2b67b570", // Permit2 permit
]);

export function selectorOf(data: Hex): string {
  return data.slice(0, 10).toLowerCase();
}

function padAddress(a: Address): string {
  return a.toLowerCase().slice(2).padStart(64, "0");
}

/**
 * Re-targets someone else's mint calldata at our wallet by swapping every
 * ABI-encoded (32-byte padded) occurrence of their address for ours, e.g.
 * `mint(address to, uint256 qty)`. Only word-aligned slots after the selector
 * are touched so unrelated bytes that merely contain the address are left alone.
 */
export function retargetCalldata(data: Hex, originalMinter: Address, ours: Address): Hex {
  const from = padAddress(originalMinter);
  const to = padAddress(ours);
  const body = data.slice(10).toLowerCase();
  let out = "";
  for (let i = 0; i < body.length; i += 64) {
    const word = body.slice(i, i + 64);
    out += word === from ? to : word;
  }
  return `${data.slice(0, 10).toLowerCase()}${out}` as Hex;
}
