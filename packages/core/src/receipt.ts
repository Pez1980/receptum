import { randomBytes } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import { isSha256Hex, sha256Hex, type Sha256Hex } from "./hash.js";

export const RECEIPT_VERSION = "receptum/1" as const;

export type AcceptanceMode = "buyer" | "evaluator" | "auto";

/**
 * Proof that a seller delivered a specific output for a specific paid job.
 * Only hashes are ever published — never the media, prompts or customer data.
 * The normative definition is docs/SPEC.md (Receptum Receipt Format v1).
 */
export interface DeliveryReceipt {
  version: typeof RECEIPT_VERSION;
  /** Stable reference for support, audits and agents. */
  receiptId: string;
  /** sha256 of the seller's internal job id, so the id itself is never published. */
  jobIdHash: Sha256Hex;
  /** Who stands behind the delivery. `id` is a DID (did:key) or a CAIP-10 account. */
  seller: { id: string; name?: string };
  /** Optional buyer identity (CAIP-10 account or DID). */
  buyer?: { id: string };
  /** Hash of each input the seller received (e.g. source video). */
  inputSha256: Sha256Hex[];
  /** Hash of the delivered artifact. */
  outputSha256: Sha256Hex;
  /** Optional hashes of supporting evidence, e.g. edit plan or QA report. */
  evidence?: Record<string, Sha256Hex>;
  /** The payment this receipt settles. */
  payment: {
    /** Payment or escrow rail, e.g. "x402:exact", "escrow:receptum-evm", "escrow:xrpl". */
    rail: string;
    /** CAIP-2 network id, e.g. "eip155:84532", "stellar:testnet", "xrpl:1". */
    network: string;
    /** Asset identifier, e.g. "USDC" or a contract address. */
    asset: string;
    /** Integer amount in the asset's smallest unit, as a decimal string. */
    amount: string;
    /** Rail-specific reference: tx hash, escrow id, or payment proof id. */
    reference: string;
    /** CAIP-10 account of the payer, when known. */
    payer?: string;
    /** CAIP-10 account that received (or will receive) the funds. Verifiers check it. */
    payee?: string;
  };
  /** How the delivery is accepted before funds are released. */
  acceptance: {
    mode: AcceptanceMode;
    /** Seconds after delivery during which the buyer (or evaluator) may reject. */
    reviewWindowSeconds: number;
    /** Identity of the evaluator when mode is "evaluator". */
    evaluator?: string;
  };
  /** Seller's signed commitment for defects found after release. */
  remedy?: {
    kind: "rerender" | "refund" | "terms";
    withinDays?: number;
    /** sha256 of a terms document, when kind is "terms" or terms apply. */
    termsSha256?: Sha256Hex;
  };
  /** receiptHash of an earlier receipt this one replaces (e.g. a re-render). */
  supersedes?: Sha256Hex;
  /** ISO-8601 UTC delivery time. */
  deliveredAt: string;
}

export interface ReceiptInput {
  jobId: string;
  seller: DeliveryReceipt["seller"];
  buyer?: DeliveryReceipt["buyer"];
  inputSha256: Sha256Hex[];
  outputSha256: Sha256Hex;
  evidence?: Record<string, Sha256Hex>;
  payment: DeliveryReceipt["payment"];
  acceptance?: Partial<DeliveryReceipt["acceptance"]>;
  remedy?: DeliveryReceipt["remedy"];
  supersedes?: Sha256Hex;
  receiptId?: string;
  deliveredAt?: Date;
}

/** Default review window: 24 hours. Sellers set longer windows per job type. */
export const DEFAULT_REVIEW_WINDOW_SECONDS = 86_400;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A short, human-readable receipt id such as RCPT-7F3A-21C9. */
export function newReceiptId(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (const b of bytes) out += CROCKFORD[b & 31];
  return `RCPT-${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

export function createReceipt(input: ReceiptInput): DeliveryReceipt {
  const receipt: DeliveryReceipt = {
    version: RECEIPT_VERSION,
    receiptId: input.receiptId ?? newReceiptId(),
    jobIdHash: sha256Hex(input.jobId),
    seller: { ...input.seller },
    inputSha256: [...input.inputSha256],
    outputSha256: input.outputSha256,
    payment: { ...input.payment },
    acceptance: {
      mode: input.acceptance?.mode ?? "auto",
      reviewWindowSeconds: input.acceptance?.reviewWindowSeconds ?? DEFAULT_REVIEW_WINDOW_SECONDS,
      ...(input.acceptance?.evaluator ? { evaluator: input.acceptance.evaluator } : {}),
    },
    deliveredAt: (input.deliveredAt ?? new Date()).toISOString(),
    ...(input.buyer ? { buyer: { ...input.buyer } } : {}),
    ...(input.evidence ? { evidence: { ...input.evidence } } : {}),
    ...(input.remedy ? { remedy: { ...input.remedy } } : {}),
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
  };
  assertValidReceipt(receipt);
  return receipt;
}

const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const RECEIPT_ID = /^RCPT-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const AMOUNT = /^(0|[1-9][0-9]*)$/;

const ALLOWED: Record<string, readonly string[]> = {
  receipt: [
    "version",
    "receiptId",
    "jobIdHash",
    "seller",
    "buyer",
    "inputSha256",
    "outputSha256",
    "evidence",
    "payment",
    "acceptance",
    "remedy",
    "supersedes",
    "deliveredAt",
  ],
  seller: ["id", "name"],
  buyer: ["id"],
  payment: ["rail", "network", "asset", "amount", "reference", "payer", "payee"],
  acceptance: ["mode", "reviewWindowSeconds", "evaluator"],
  remedy: ["kind", "withinDays", "termsSha256"],
};

/**
 * Validates a receipt exactly as SPEC §2 defines it: only permitted members at every level,
 * correct JSON types, no nulls, own properties only. Anything else is rejected before
 * hashing or signing so a receipt can never smuggle extra data (e.g. raw prompts).
 */
export function assertValidReceipt(receipt: DeliveryReceipt): void {
  const fail = (msg: string): never => {
    throw new TypeError(`invalid receipt: ${msg}`);
  };
  const obj = (v: unknown, path: string, shape: string): Record<string, unknown> => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) fail(`${path} must be an object`);
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) fail(`${path} must be a plain object`);
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (!ALLOWED[shape]!.includes(k)) fail(`${path}.${k} is not part of RRF v1`);
      if (o[k] === null) fail(`${path}.${k} must be omitted, not null`);
    }
    return o;
  };
  const has = (o: Record<string, unknown>, k: string) => Object.hasOwn(o, k) && o[k] !== undefined;
  const text = (o: Record<string, unknown>, k: string, path: string, required = true) => {
    if (!has(o, k)) return required ? fail(`${path}.${k} is required`) : undefined;
    if (typeof o[k] !== "string" || (o[k] as string).length === 0)
      fail(`${path}.${k} must be a non-empty string`);
    return o[k] as string;
  };
  const hash = (v: unknown, path: string) => (isSha256Hex(v) ? v : fail(path));

  const r = obj(receipt, "receipt", "receipt");
  if (r.version !== RECEIPT_VERSION) fail("unknown version");
  if (!RECEIPT_ID.test(text(r, "receiptId", "receipt")!)) fail("receiptId");
  hash(r.jobIdHash, "jobIdHash");

  const seller = obj(r.seller, "seller", "seller");
  text(seller, "id", "seller");
  text(seller, "name", "seller", false);
  if (has(r, "buyer")) text(obj(r.buyer, "buyer", "buyer"), "id", "buyer");

  if (!Array.isArray(r.inputSha256) || r.inputSha256.length === 0)
    fail("at least one input hash is required");
  (r.inputSha256 as unknown[]).forEach((h, i) => hash(h, `inputSha256[${i}]`));
  hash(r.outputSha256, "outputSha256");
  if (has(r, "evidence")) {
    const ev = r.evidence;
    if (
      typeof ev !== "object" ||
      ev === null ||
      Array.isArray(ev) ||
      Object.getPrototypeOf(ev) !== Object.prototype
    )
      fail("evidence must be an object");
    for (const [k, h] of Object.entries(ev as object)) hash(h, `evidence.${k}`);
  }

  const p = obj(r.payment, "payment", "payment");
  for (const k of ["rail", "network", "asset", "amount", "reference"]) text(p, k, "payment");
  text(p, "payer", "payment", false);
  text(p, "payee", "payment", false);
  if (!AMOUNT.test(p.amount as string))
    fail("payment.amount must be a non-negative integer string");
  if (!CAIP2.test(p.network as string)) fail("payment.network must be a CAIP-2 id");

  const a = obj(r.acceptance, "acceptance", "acceptance");
  if (!["buyer", "evaluator", "auto"].includes(a.mode as string)) fail("acceptance.mode");
  if (!Number.isSafeInteger(a.reviewWindowSeconds) || (a.reviewWindowSeconds as number) < 0)
    fail("acceptance.reviewWindowSeconds");
  text(a, "evaluator", "acceptance", a.mode === "evaluator");

  if (has(r, "remedy")) {
    const m = obj(r.remedy, "remedy", "remedy");
    if (!["rerender", "refund", "terms"].includes(m.kind as string)) fail("remedy.kind");
    if (
      has(m, "withinDays") &&
      (!Number.isSafeInteger(m.withinDays) || (m.withinDays as number) < 0)
    )
      fail("remedy.withinDays");
    if (has(m, "termsSha256")) hash(m.termsSha256, "remedy.termsSha256");
    if (m.kind === "terms" && !has(m, "termsSha256")) fail("remedy.termsSha256 is required");
  }
  if (has(r, "supersedes")) hash(r.supersedes, "supersedes");
  const at = text(r, "deliveredAt", "receipt")!;
  if (!RFC3339_UTC.test(at) || Number.isNaN(Date.parse(at)))
    fail("deliveredAt must be an RFC 3339 UTC timestamp");
}

/** JCS (RFC 8785) bytes of a receipt — what gets hashed and signed. */
export function receiptBytes(receipt: DeliveryReceipt): string {
  assertValidReceipt(receipt);
  return canonicalJson(receipt);
}

/** The single value anchored on-chain for a receipt. */
export function receiptHash(receipt: DeliveryReceipt): Sha256Hex {
  return sha256Hex(receiptBytes(receipt));
}
