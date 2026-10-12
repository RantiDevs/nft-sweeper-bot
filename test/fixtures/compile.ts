import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Abi, Hex } from "viem";

const require = createRequire(import.meta.url);
const solc = require("solc");

export function compileFixtures(): Record<string, { abi: Abi; bytecode: Hex }> {
  const source = readFileSync(fileURLToPath(new URL("./Nfts.sol", import.meta.url)), "utf8");
  const input = {
    language: "Solidity",
    sources: { "Nfts.sol": { content: source } },
    settings: { evmVersion: "shanghai", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  const res: Record<string, { abi: Abi; bytecode: Hex }> = {};
  for (const [name, c] of Object.entries(out.contracts["Nfts.sol"]) as [string, any][]) {
    res[name] = { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
  }
  return res;
}
