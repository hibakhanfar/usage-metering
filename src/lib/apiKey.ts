import { createHash, randomBytes } from "node:crypto";

const KEY_PREFIX = "um_live_";

export function generateApiKey(): string {
return KEY_PREFIX + randomBytes(32).toString("base64url");
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}