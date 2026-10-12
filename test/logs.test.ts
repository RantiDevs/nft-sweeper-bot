import { describe, expect, it } from "vitest";
import { encodeAbiParameters, type Hex } from "viem";
import { parseMintLog, TRANSFER_BATCH_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_TOPIC, ZERO_TOPIC } from "../src/logs.js";

const C = "0x00000000000000000000000000000000000000c1";
const toTopic = `0x${"ab".repeat(20).padStart(64, "0")}` as Hex;
const base = { address: C, transactionHash: ZERO_TOPIC, blockNumber: 1n } as const;

describe("parseMintLog", () => {
  it("parses ERC721 mints", () => {
    const m = parseMintLog({ ...base, topics: [TRANSFER_TOPIC, ZERO_TOPIC, toTopic, ZERO_TOPIC] });
    expect(m?.to.toLowerCase()).toBe(`0x${"ab".repeat(20)}`);
  });

  it("ignores ERC20 mints (tokenId not indexed)", () => {
    expect(parseMintLog({ ...base, topics: [TRANSFER_TOPIC, ZERO_TOPIC, toTopic] })).toBeNull();
  });

  it("ignores ERC721 transfers that are not mints", () => {
    expect(parseMintLog({ ...base, topics: [TRANSFER_TOPIC, toTopic, toTopic, ZERO_TOPIC] })).toBeNull();
  });

  it("parses ERC1155 single and batch mints with ids and amounts", () => {
    const single = parseMintLog({
      ...base,
      topics: [TRANSFER_SINGLE_TOPIC, toTopic, ZERO_TOPIC, toTopic],
      data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [7n, 3n]),
    });
    expect(single).toMatchObject({ standard: "erc1155", tokens: [{ id: 7n, amount: 3n }] });
    const batch = parseMintLog({
      ...base,
      topics: [TRANSFER_BATCH_TOPIC, toTopic, ZERO_TOPIC, toTopic],
      data: encodeAbiParameters([{ type: "uint256[]" }, { type: "uint256[]" }], [[1n, 2n], [5n, 6n]]),
    });
    expect(batch?.tokens).toEqual([{ id: 1n, amount: 5n }, { id: 2n, amount: 6n }]);
  });

  it("returns null on malformed data instead of throwing", () => {
    expect(parseMintLog({ ...base, topics: [TRANSFER_BATCH_TOPIC, toTopic, ZERO_TOPIC, toTopic], data: "0x1234" })).toBeNull();
  });
});
