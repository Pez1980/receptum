import { describe, expect, it } from "vitest";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import {
  escrowClaimants,
  parseEscrowTerms,
  type EscrowTerms,
  type HorizonClaimant,
} from "./predicates.js";

const buyer = Keypair.random().publicKey();
const seller = Keypair.random().publicKey();
const terms: EscrowTerms = { buyer, seller, deadline: 1_800_000_000, releaseAt: 1_800_000_600 };

/** The SDK v17 XDR value shape of a claim predicate. */
interface PredicateValue {
  type: string;
  andPredicates?: PredicateValue[];
  notPredicate?: PredicateValue | null;
  absBefore?: bigint;
}

/** Mirrors how Horizon renders our predicates as JSON. */
function toHorizon(value: xdr.ClaimPredicate): HorizonClaimant["predicate"] {
  const p = value as unknown as PredicateValue;
  switch (p.type) {
    case "claimPredicateAnd":
      return { and: p.andPredicates!.map((x) => toHorizon(x as unknown as xdr.ClaimPredicate)) };
    case "claimPredicateNot":
      return { not: toHorizon(p.notPredicate as unknown as xdr.ClaimPredicate) };
    case "claimPredicateBeforeAbsoluteTime": {
      const t = p.absBefore!.toString();
      return { abs_before: new Date(Number(t) * 1000).toISOString(), abs_before_epoch: t };
    }
    default:
      throw new Error(`unexpected predicate ${p.type}`);
  }
}

const horizonClaimants = (t: EscrowTerms) =>
  escrowClaimants(t).map((c) => ({
    destination: c.destination,
    predicate: toHorizon(c.predicate),
  }));

it("encodes the buyer predicate to the expected XDR", () => {
  const [, b] = escrowClaimants({ ...terms, deadline: 100, releaseAt: 200 });
  // and(not(before(100)), before(200))
  expect(b!.predicate.toXDR("base64")).toBe(
    "AAAAAQAAAAIAAAADAAAAAQAAAAQAAAAAAAAAZAAAAAQAAAAAAAAAyA==",
  );
});

describe("escrow claimants", () => {
  it("gives the seller not-before(releaseAt) and the buyer [deadline, releaseAt)", () => {
    const [s, b] = escrowClaimants(terms);
    expect(s!.destination).toBe(seller);
    expect(b!.destination).toBe(buyer);
    expect(toHorizon(s!.predicate)).toEqual({
      not: { abs_before: "2027-01-15T08:10:00.000Z", abs_before_epoch: "1800000600" },
    });
    expect(toHorizon(b!.predicate)).toEqual({
      and: [
        { not: { abs_before: "2027-01-15T08:00:00.000Z", abs_before_epoch: "1800000000" } },
        { abs_before: "2027-01-15T08:10:00.000Z", abs_before_epoch: "1800000600" },
      ],
    });
  });

  it("refuses an empty buyer window and identical parties", () => {
    expect(() => escrowClaimants({ ...terms, releaseAt: terms.deadline })).toThrow(/review window/);
    expect(() => escrowClaimants({ ...terms, seller: buyer })).toThrow(/differ/);
    expect(() => escrowClaimants({ ...terms, deadline: 1.5 })).toThrow(/unix seconds/);
  });

  it("produces windows that never overlap", () => {
    const claimable = (who: "buyer" | "seller", t: number) =>
      who === "seller" ? t >= terms.releaseAt : t >= terms.deadline && t < terms.releaseAt;
    for (const t of [terms.deadline - 1, terms.deadline, terms.releaseAt - 1, terms.releaseAt]) {
      expect(claimable("buyer", t) && claimable("seller", t)).toBe(false);
    }
  });
});

describe("parseEscrowTerms", () => {
  it("round-trips the claimants Horizon reports", () => {
    expect(parseEscrowTerms(horizonClaimants(terms))).toEqual(terms);
    expect(parseEscrowTerms(horizonClaimants(terms).reverse())).toEqual(terms);
  });

  it("falls back to the ISO time when abs_before_epoch is absent", () => {
    const claimants = JSON.parse(
      JSON.stringify(horizonClaimants(terms)).replace(/,"abs_before_epoch":"\d+"/g, ""),
    ) as HorizonClaimant[];
    expect(parseEscrowTerms(claimants)).toEqual(terms);
  });

  it("rejects balances that are not Receptum escrows", () => {
    const [s, b] = horizonClaimants(terms);
    expect(() => parseEscrowTerms([s!])).toThrow(/2 claimants/);
    expect(() =>
      parseEscrowTerms([s!, { destination: buyer, predicate: { unconditional: true } }]),
    ).toThrow(/unexpected predicates/);
    expect(() =>
      parseEscrowTerms([s!, { destination: buyer, predicate: { rel_before: "600" } }]),
    ).toThrow(/unexpected predicates/);
    const gap = horizonClaimants({ ...terms, releaseAt: terms.releaseAt + 1 })[1]!;
    expect(() => parseEscrowTerms([s!, gap])).toThrow(/contiguous/);
    expect(b).toBeDefined();
  });
});
