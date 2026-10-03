import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// PREIMAGE-SHA-256 crypto-conditions (draft-thomas-crypto-conditions-02), the
// only type XRPL Escrow accepts. Everything is DER, hex upper-case on the wire.

export interface EscrowSecret {
  /** 32 random bytes, hex. Kept by the buyer; revealing it releases the escrow. */
  preimage: string;
  /** Goes on-chain in EscrowCreate.Condition. */
  condition: string;
  /** Revealed in EscrowFinish.Fulfillment. */
  fulfillment: string;
}

/** A fresh, single-use secret for one escrow. Never reuse it: finishing reveals it publicly. */
export function newEscrowSecret(): EscrowSecret {
  const preimage = randomBytes(32);
  return {
    preimage: preimage.toString("hex"),
    condition: conditionFromPreimage(preimage),
    fulfillment: fulfillmentFromPreimage(preimage),
  };
}

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n <= 0xff) return Buffer.from([0x81, n]);
  if (n <= 0xffff) return Buffer.from([0x82, n >> 8, n & 0xff]);
  throw new RangeError("DER length too large");
}

const tlv = (tag: number, value: Buffer) =>
  Buffer.concat([Buffer.from([tag]), derLength(value.length), value]);

function derUint(n: number): Buffer {
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const bytes = Buffer.from(hex, "hex");
  return bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
}

const bytesOf = (preimage: Uint8Array | string) =>
  typeof preimage === "string" ? Buffer.from(preimage, "hex") : Buffer.from(preimage);

export function fulfillmentFromPreimage(preimage: Uint8Array | string): string {
  return tlv(0xa0, tlv(0x80, bytesOf(preimage)))
    .toString("hex")
    .toUpperCase();
}

export function conditionFromPreimage(preimage: Uint8Array | string): string {
  const bytes = bytesOf(preimage);
  const fingerprint = createHash("sha256").update(bytes).digest();
  return tlv(0xa0, Buffer.concat([tlv(0x80, fingerprint), tlv(0x81, derUint(bytes.length))]))
    .toString("hex")
    .toUpperCase();
}

/** Extracts the preimage from a PREIMAGE-SHA-256 fulfillment; throws on anything else. */
export function preimageFromFulfillment(fulfillment: string): Buffer {
  const der = Buffer.from(fulfillment, "hex");
  const read = (buf: Buffer, tag: number): Buffer => {
    if (buf[0] !== tag) throw new TypeError("not a PREIMAGE-SHA-256 fulfillment");
    let len = buf[1] ?? 0;
    let off = 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = buf.subarray(2, 2 + n).reduce((acc, b) => acc * 256 + b, 0);
      off += n;
    }
    if (off + len !== buf.length) throw new TypeError("malformed fulfillment");
    return buf.subarray(off);
  };
  return read(read(der, 0xa0), 0x80);
}

/** True if `fulfillment` satisfies `condition`. */
export function fulfillmentMatches(condition: string, fulfillment: string): boolean {
  try {
    const expected = Buffer.from(
      conditionFromPreimage(preimageFromFulfillment(fulfillment)),
      "hex",
    );
    const actual = Buffer.from(condition, "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
