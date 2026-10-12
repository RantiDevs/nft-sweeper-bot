import { describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi } from "viem";
import { retargetCalldata, selectorOf } from "../src/calldata.js";

const abi = parseAbi(["function mint(address to, uint256 qty)", "function claim(uint256 qty)"]);
const them = "0x1111111111111111111111111111111111111111";
const me = "0x2222222222222222222222222222222222222222";

describe("retargetCalldata", () => {
  it("swaps the original minter's address for ours", () => {
    const data = encodeFunctionData({ abi, functionName: "mint", args: [them, 3n] });
    expect(retargetCalldata(data, them, me)).toBe(
      encodeFunctionData({ abi, functionName: "mint", args: [me, 3n] }),
    );
  });

  it("leaves calldata without the address unchanged", () => {
    const data = encodeFunctionData({ abi, functionName: "claim", args: [1n] });
    expect(retargetCalldata(data, them, me)).toBe(data);
  });

  it("does not touch non word-aligned matches", () => {
    const data = `0xdeadbeef00${them.slice(2).padStart(64, "0")}` as const;
    expect(retargetCalldata(data, them, me)).toBe(data);
    expect(selectorOf(data)).toBe("0xdeadbeef");
  });
});
