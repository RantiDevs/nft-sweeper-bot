import { existsSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Usage: npm run wallets:new -- <count> [file]
const count = Number(process.argv[2] ?? 20);
const file = process.argv[3] ?? "wallets.txt";
if (!Number.isInteger(count) || count < 1 || count > 10_000) {
  console.error("count must be an integer between 1 and 10000");
  process.exit(1);
}
if (existsSync(file)) {
  console.error(`${file} already exists; refusing to overwrite keys. Pick another file name.`);
  process.exit(1);
}
const keys = Array.from({ length: count }, () => generatePrivateKey());
writeFileSync(file, `# ${count} burner wallets generated ${new Date().toISOString()}\n${keys.join("\n")}\n`, { mode: 0o600 });
console.log(`Wrote ${count} private keys to ${file} (mode 600). Set KEYS_FILE=${file}. Back it up; never commit it.\n`);
keys.forEach((k, i) => console.log(`w${String(i + 1).padStart(2, "0")} ${privateKeyToAccount(k).address}`));
