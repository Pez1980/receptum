import { describe, expect, it } from "vitest";
import {
  Address,
  Asset,
  Keypair,
  Networks,
  StrKey,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { sha256Hex } from "@receptum/core";
import { TESTNET_USDC } from "./network.js";
import {
  SOROBAN_ESCROW_CAPABILITIES,
  SorobanEscrowRail,
  TESTNET_USDC_SAC,
  decodeEscrowRecord,
  describeContractError,
  escrowStorageKey,
  formatSorobanEscrowId,
  parseSorobanEscrowId,
  sorobanEscrowState,
  tokenContractId,
} from "./soroban.js";
import { CLAIMABLE_ESCROW_CAPABILITIES, StellarClaimableEscrowRail } from "./escrow.js";
import { keypairSigner } from "./signer.js";

const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));
const buyer = Keypair.random().publicKey();
const seller = Keypair.random().publicKey();
const evaluator = Keypair.random().publicKey();
const receiptHash = sha256Hex("receipt");

/** Builds the contract's `Escrow` struct exactly as the host serializes it (sorted symbol keys). */
function record(over: Partial<Record<string, xdr.ScVal>> = {}): xdr.ScVal {
  const fields: Record<string, xdr.ScVal> = {
    amount: nativeToScVal(10_000_000n, { type: "i128" }),
    buyer: new Address(buyer).toScVal(),
    deliver_by: nativeToScVal(1_800_000_000n, { type: "u64" }),
    delivered_at: nativeToScVal(0n, { type: "u64" }),
    evaluator: xdr.ScVal.scvVoid(),
    receipt_hash: xdr.ScVal.scvVoid(),
    review_window: nativeToScVal(600, { type: "u32" }),
    seller: new Address(seller).toScVal(),
    status: nativeToScVal(1, { type: "u32" }),
    token: new Address(TESTNET_USDC_SAC).toScVal(),
    ...over,
  };
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: fields[k]! })),
  );
}

describe("Soroban escrow ids", () => {
  it("round-trips stellar:testnet:<contract>:<id>", () => {
    const id = formatSorobanEscrowId(contractId, 7n);
    expect(id).toBe(`stellar:testnet:${contractId}:7`);
    expect(parseSorobanEscrowId(id)).toEqual({ contractId, id: 7n });
  });

  it("rejects malformed ids", () => {
    for (const bad of [
      `stellar:testnet:${contractId}:0`,
      `stellar:testnet:${contractId}:07`,
      `stellar:pubnet:${contractId}:1`,
      `stellar:testnet:${buyer}:1`,
      `stellar:testnet:${contractId}:18446744073709551616`,
      `stellar:testnet:${contractId}`,
    ]) {
      expect(() => parseSorobanEscrowId(bad)).toThrow(/invalid Soroban escrowId/);
    }
    expect(() => formatSorobanEscrowId(buyer, 1n)).toThrow(/invalid contract id/);
  });

  it("encodes the storage key as DataKey::Escrow(u64)", () => {
    const key = escrowStorageKey(5n);
    expect(key.toXdr("base64")).toBe("AAAAEAAAAAEAAAACAAAADwAAAAZFc2Nyb3cAAAAAAAUAAAAAAAAABQ==");
  });
});

describe("tokenContractId", () => {
  it("maps classic assets to their testnet Stellar Asset Contract", () => {
    const usdc = new Asset("USDC", TESTNET_USDC.split(":")[1]!).contractId(Networks.TESTNET);
    expect(tokenContractId(TESTNET_USDC)).toBe(usdc);
    expect(TESTNET_USDC_SAC).toBe(usdc);
    expect(tokenContractId("native")).toBe(Asset.native().contractId(Networks.TESTNET));
    expect(tokenContractId(contractId)).toBe(contractId);
    expect(() => tokenContractId("USDC")).toThrow();
  });
});

describe("decodeEscrowRecord", () => {
  it("decodes an open escrow", () => {
    expect(decodeEscrowRecord(record())).toEqual({
      buyer,
      seller,
      token: TESTNET_USDC_SAC,
      amount: 10_000_000n,
      deliverBy: 1_800_000_000,
      reviewWindowSeconds: 600,
      deliveredAt: 0,
      status: "open",
    });
  });

  it("decodes a delivered escrow with an evaluator", () => {
    const r = decodeEscrowRecord(
      record({
        evaluator: new Address(evaluator).toScVal(),
        receipt_hash: xdr.ScVal.scvBytes(Buffer.from(receiptHash, "hex")),
        delivered_at: nativeToScVal(1_799_999_000n, { type: "u64" }),
        status: nativeToScVal(2, { type: "u32" }),
      }),
    );
    expect(r).toMatchObject({
      evaluator,
      receiptHash,
      status: "delivered",
      deliveredAt: 1_799_999_000,
    });
  });

  it("rejects anything that isn't exactly the contract's struct", () => {
    const bad = [
      record({ status: nativeToScVal(9, { type: "u32" }) }),
      record({ amount: nativeToScVal(0n, { type: "i128" }) }),
      record({ receipt_hash: xdr.ScVal.scvBytes(Buffer.alloc(31)) }),
      record({ token: new Address(buyer).toScVal() }),
      record({ extra: nativeToScVal(1, { type: "u32" }) }),
      xdr.ScVal.scvU32(1),
    ];
    for (const v of bad) expect(() => decodeEscrowRecord(v)).toThrow(/not a ReceptumEscrow record/);
  });
});

describe("sorobanEscrowState", () => {
  it("states the refund time and, once delivered, the release time", () => {
    const open = sorobanEscrowState(contractId, 3n, decodeEscrowRecord(record()));
    expect(open).toMatchObject({
      rail: "escrow:receptum-soroban",
      network: "stellar:testnet",
      escrowId: `stellar:testnet:${contractId}:3`,
      amount: "10000000",
      asset: TESTNET_USDC_SAC,
      status: "open",
      refundableAfter: "2027-01-15T08:00:00.000Z",
    });
    expect(open.releasableAfter).toBeUndefined();
    const delivered = sorobanEscrowState(
      contractId,
      3n,
      decodeEscrowRecord(
        record({
          receipt_hash: xdr.ScVal.scvBytes(Buffer.from(receiptHash, "hex")),
          delivered_at: nativeToScVal(1_799_999_000n, { type: "u64" }),
          status: nativeToScVal(2, { type: "u32" }),
        }),
      ),
    );
    // The review window runs from the delivery, not from the deadline.
    expect(delivered).toMatchObject({
      status: "delivered",
      receiptHash,
      deliveredAt: "2027-01-15T07:43:20.000Z",
      releasableAfter: "2027-01-15T07:53:20.000Z",
    });
  });
});

describe("describeContractError", () => {
  it("names contract errors from simulation failures", () => {
    const e = describeContractError(new Error("HostError: Error(Contract, #4)\n..."));
    expect(e.message).toBe("ReceptumEscrow rejected the call: TooLate");
    const other = new Error("network down");
    expect(describeContractError(other)).toBe(other);
  });
});

describe("capabilities", () => {
  it("publishes what each Stellar rail enforces on-chain", () => {
    expect(SOROBAN_ESCROW_CAPABILITIES).toEqual({
      acceptanceModes: ["buyer", "evaluator", "auto"],
      reviewWindowFromDelivery: true,
      refundAfterDelivery: true,
    });
    expect(CLAIMABLE_ESCROW_CAPABILITIES).toEqual({
      acceptanceModes: ["buyer", "auto"],
      reviewWindowFromDelivery: false,
      refundAfterDelivery: true,
    });
    const signer = keypairSigner(Keypair.random());
    expect(new SorobanEscrowRail({ contractId, signer }).capabilities).toBe(
      SOROBAN_ESCROW_CAPABILITIES,
    );
    expect(new StellarClaimableEscrowRail({ signer }).capabilities).toBe(
      CLAIMABLE_ESCROW_CAPABILITIES,
    );
  });

  it("refuses escrows of another contract and calls without a signer", async () => {
    const rail = new SorobanEscrowRail({ contractId });
    const other = StrKey.encodeContract(Buffer.alloc(32, 8));
    await expect(rail.getEscrow(`stellar:testnet:${other}:1`)).rejects.toThrow(/another contract/);
    await expect(rail.release(`stellar:testnet:${contractId}:1`)).rejects.toThrow(/no signer/);
    expect(() => new SorobanEscrowRail({ contractId: buyer })).toThrow(/invalid contract id/);
  });
});
