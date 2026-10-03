import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

const SHA256_HEX = /^[0-9a-f]{64}$/;

export type Sha256Hex = string;

export function isSha256Hex(value: unknown): value is Sha256Hex {
  return typeof value === "string" && SHA256_HEX.test(value);
}

export function sha256Hex(data: string | Uint8Array): Sha256Hex {
  return createHash("sha256").update(data).digest("hex");
}

/** Streams a file through SHA-256 so large media never has to fit in memory. */
export async function sha256File(path: string): Promise<Sha256Hex> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
