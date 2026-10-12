import { readFileSync } from "node:fs";
import { createWalletClient, type Chain, type PrivateKeyAccount, type Transport, type HDAccount, type WalletClient } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { normalizeKey, type Config } from "./config.js";

export type BotAccount = PrivateKeyAccount | HDAccount;

export interface Wallet {
  /** Short label for logs, e.g. "w07". */
  label: string;
  account: BotAccount;
  client: WalletClient;
}

/** Reads one private key per line; blank lines and `#` comments are ignored. */
export function readKeysFile(path: string): string[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean);
}

/** Merges PRIVATE_KEYS, KEYS_FILE and MNEMONIC-derived accounts, de-duplicated by address. */
export function loadAccounts(cfg: Config): BotAccount[] {
  const accounts: BotAccount[] = [];
  const keys = [...cfg.privateKeys, ...(cfg.keysFile ? readKeysFile(cfg.keysFile).map(normalizeKey) : [])];
  for (const k of keys) accounts.push(privateKeyToAccount(k));
  if (cfg.mnemonic) {
    for (let i = 0; i < cfg.walletCount; i++) {
      accounts.push(mnemonicToAccount(cfg.mnemonic, { addressIndex: i }));
    }
  }
  const seen = new Set<string>();
  return accounts.filter((a) => !seen.has(a.address) && (seen.add(a.address), true));
}

export function makeWallets(accounts: BotAccount[], chain: Chain, transport: Transport): Wallet[] {
  const width = String(accounts.length).length;
  return accounts.map((account, i) => ({
    label: `w${String(i + 1).padStart(Math.max(2, width), "0")}`,
    account,
    client: createWalletClient({ account, chain, transport }),
  }));
}
