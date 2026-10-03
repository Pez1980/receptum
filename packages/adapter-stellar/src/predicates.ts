import { Claimant } from "@stellar/stellar-sdk";

/**
 * Time windows of a Receptum claimable-balance escrow (unix seconds).
 *
 * ```
 *   created ─────────── deadline ─────────────── releaseAt ──────────▶
 *   │ nobody can claim  │ buyer may claim         │ seller may claim
 *   │ (seller works,    │ (refund if undelivered, │ (auto-release)
 *   │  delivers)        │  reject, or accept)     │
 * ```
 *
 * Seller: `not(before(releaseAt))`. Buyer: `not(before(deadline)) and before(releaseAt)`.
 * The two windows never overlap, so at any ledger time at most one party can claim.
 */
export interface EscrowTerms {
  buyer: string;
  seller: string;
  /** Delivery deadline: start of the buyer's window. */
  deadline: number;
  /** deadline + review window: start of the seller's window. */
  releaseAt: number;
}

export function assertValidTerms(terms: EscrowTerms): void {
  if (terms.buyer === terms.seller) throw new TypeError("buyer and seller must differ");
  for (const [k, v] of [
    ["deadline", terms.deadline],
    ["releaseAt", terms.releaseAt],
  ] as const) {
    if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError(`${k} must be unix seconds`);
  }
  if (terms.releaseAt <= terms.deadline) {
    throw new TypeError("review window must be > 0: the buyer's refund window would be empty");
  }
}

/** The two claimants of a Receptum escrow balance. */
export function escrowClaimants(terms: EscrowTerms): Claimant[] {
  assertValidTerms(terms);
  const before = (t: number) => Claimant.predicateBeforeAbsoluteTime(String(t));
  return [
    new Claimant(terms.seller, Claimant.predicateNot(before(terms.releaseAt))),
    new Claimant(
      terms.buyer,
      Claimant.predicateAnd(Claimant.predicateNot(before(terms.deadline)), before(terms.releaseAt)),
    ),
  ];
}

// ─── Parsing Horizon's JSON predicates back into terms ────────────────────

/** Horizon's JSON rendering of a claim predicate. */
export interface HorizonPredicate {
  unconditional?: boolean;
  and?: HorizonPredicate[];
  or?: HorizonPredicate[];
  not?: HorizonPredicate;
  abs_before?: string;
  abs_before_epoch?: string;
  rel_before?: string;
}

export interface HorizonClaimant {
  destination: string;
  predicate: HorizonPredicate;
}

/** `{abs_before}` → unix seconds, or null for any other predicate shape. */
function absBefore(p: HorizonPredicate | undefined): number | null {
  if (!p || p.abs_before === undefined || Object.keys(p).some((k) => !k.startsWith("abs_before"))) {
    return null;
  }
  const epoch = p.abs_before_epoch ?? String(Date.parse(p.abs_before) / 1000);
  const n = Number(epoch);
  return Number.isSafeInteger(n) ? n : null;
}

/** `{not: {abs_before}}` → unix seconds. */
function notBefore(p: HorizonPredicate | undefined): number | null {
  if (!p?.not || Object.keys(p).length !== 1) return null;
  return absBefore(p.not);
}

/** `{and: [{not: {abs_before: a}}, {abs_before: b}]}` (either order) → [a, b]. */
function window(p: HorizonPredicate): [number, number] | null {
  if (!p.and || p.and.length !== 2 || Object.keys(p).length !== 1) return null;
  const [x, y] = p.and;
  const from = notBefore(x) ?? notBefore(y);
  const until = absBefore(x) ?? absBefore(y);
  return from !== null && until !== null ? [from, until] : null;
}

/**
 * Recovers escrow terms from a balance's claimants, or throws if the balance
 * does not have exactly the Receptum shape (so arbitrary balances are never
 * mistaken for escrows).
 */
export function parseEscrowTerms(claimants: HorizonClaimant[]): EscrowTerms {
  if (claimants.length !== 2) throw new TypeError("not a Receptum escrow: expected 2 claimants");
  let seller: { address: string; releaseAt: number } | undefined;
  let buyer: { address: string; from: number; until: number } | undefined;
  for (const c of claimants) {
    const releaseAt = notBefore(c.predicate);
    const w = window(c.predicate);
    if (releaseAt !== null) seller = { address: c.destination, releaseAt };
    else if (w) buyer = { address: c.destination, from: w[0], until: w[1] };
  }
  if (!seller || !buyer) throw new TypeError("not a Receptum escrow: unexpected predicates");
  if (buyer.until !== seller.releaseAt) {
    throw new TypeError("not a Receptum escrow: buyer and seller windows are not contiguous");
  }
  const terms = {
    buyer: buyer.address,
    seller: seller.address,
    deadline: buyer.from,
    releaseAt: seller.releaseAt,
  };
  assertValidTerms(terms);
  return terms;
}
