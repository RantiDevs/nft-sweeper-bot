import { defineChain } from "viem";

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
});

export const robinhoodChainTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  // No default public URL baked in: set RPC_URL when targeting testnet.
  rpcUrls: { default: { http: [] } },
  testnet: true,
});

export function chainFor(id: number) {
  if (id === robinhoodChain.id) return robinhoodChain;
  if (id === robinhoodChainTestnet.id) return robinhoodChainTestnet;
  throw new Error(`Unsupported CHAIN_ID ${id} (expected 4663 or 46630)`);
}
