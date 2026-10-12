import { defineChain, type Chain } from "viem";

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
  // No default public URL baked in: set RPC_URLS when targeting testnet.
  rpcUrls: { default: { http: [] } },
  testnet: true,
});

/**
 * Robinhood Chain mainnet/testnet, or any other EVM chain (e.g. a local fork)
 * when CHAIN_ID is something else and RPC_URLS is set.
 */
export function chainFor(id: number): Chain {
  if (id === robinhoodChain.id) return robinhoodChain;
  if (id === robinhoodChainTestnet.id) return robinhoodChainTestnet;
  return defineChain({
    id,
    name: `EVM chain ${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [] } },
  });
}
