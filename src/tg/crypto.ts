import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption for wallet private keys stored on disk.
 * The blob is `v1.<iv>.<tag>.<ciphertext>` (base64url). `aad` binds a blob to
 * its owner (user id + address) so ciphertexts cannot be swapped between
 * wallets or users in the data file.
 */
export function parseMasterKey(raw: string | undefined): Buffer {
  const s = (raw ?? "").trim();
  if (!s) throw new Error("MASTER_KEY is required (run `npm run tg:genkey`)");
  const key = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  if (key.length !== 32) throw new Error("MASTER_KEY must be 32 bytes: 64 hex chars or 44 base64 chars");
  return key;
}

export function generateMasterKey(): string {
  return randomBytes(32).toString("hex");
}

export function encrypt(plain: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decrypt(blob: string, key: Buffer, aad: string): string {
  const [v, iv, tag, ct] = blob.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unsupported ciphertext format");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
