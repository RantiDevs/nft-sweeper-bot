import { describe, expect, it } from "vitest";
import { type Hex } from "viem";
import { parseMintLog, TRANSFER_SINGLE_TOPIC, TRANSFER_TOPIC, ZERO_TOPIC } from "../src/logs.js";

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

  it("parses ERC1155 mints", () => {
    const m = parseMintLog({ ...base, topics: [TRANSFER_SINGLE_TOPIC, toTopic, ZERO_TOPIC, toTopic] });
    expect(m).not.toBeNull();
  });
});
