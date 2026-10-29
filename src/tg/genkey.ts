import { generateMasterKey } from "./crypto.js";

console.log("Add this to your .env as MASTER_KEY. Back it up: without it, stored wallet keys cannot be decrypted.\n");
console.log(`MASTER_KEY=${generateMasterKey()}`);
