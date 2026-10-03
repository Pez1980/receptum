/**
 * Level 3 for `escrow:xrpl` (SPEC §7.3, "XRPL escrows"). The escrow state comes from
 * `XrplEscrowRail.getEscrow` (validated ledger history); this module decides what it proves.
 *
 * - Amount, asset (by 160-bit protocol identity, never by display symbol), buyer, seller and the
 *   committed `receiptHash` must match; any mismatch fails.
 * - Acceptance terms: the ledger proves whether release needed a fulfillment (`Condition`), the
 *   escrow's `CancelAfter`, and when the delivery memo was validated. It does not show who held
 *   the fulfillment.
 *   · `buyer`: the escrow MUST be conditional (the buyer, who created it, chose the condition),
 *     and the delivery MUST have left the buyer at least `reviewWindowSeconds` before
 *     `CancelAfter`: CancelAfter − delivery close time ≥ reviewWindowSeconds. A receipt claiming
 *     more review time than the ledger allowed fails.
 *   · `evaluator`: same ledger rules, and the evaluator must be an XRPL account on this network
 *     (`xrpl:<NetworkID>:r…`) that itself submitted the EscrowFinish: the finishing transaction's
 *     `Account` is the on-ledger proof of who decided. Finished by anyone else fails; an evaluator
 *     that is not an XRPL account (e.g. a DID) can't be shown on the ledger, so `unavailable`.
 *     Rejection is not finishing: the escrow is refunded after CancelAfter and fails, like any
 *     refund.
 *   · `auto`: a conditional escrow can't auto-release, so it fails; an unconditional one has no
 *     on-ledger review window, so it is `unavailable`.
 * - History that could not be read in full (`XrplHistoryIncompleteError`) is `unavailable`.
 */
import { isXrplClassicAddress, type SignedReceipt } from "@receptum/core";
import { parseXrplAsset, type XrplEscrowState } from "@receptum/adapter-xrpl";

export type XrplEscrowStatus = "pass" | "fail" | "pending" | "unavailable";

export interface XrplEscrowResult {
  status: XrplEscrowStatus;
  detail: string;
}

const account = (network: string, caip10: string | undefined) => {
  if (caip10 === undefined) return undefined;
  const i = caip10.lastIndexOf(":");
  return i > 0 && caip10.slice(0, i) === network ? caip10.slice(i + 1) : null;
};

function sameAsset(asset: string, state: XrplEscrowState): boolean {
  let want: ReturnType<typeof parseXrplAsset>;
  try {
    want = parseXrplAsset(asset);
  } catch {
    return false;
  }
  const got = state.xrpl;
  if (!got) return false;
  if (want.currency === "XRP") return got.currency === "XRP" && got.issuer === undefined;
  return "issuer" in want && got.currency === want.currency && got.issuer === want.issuer;
}

/**
 * The evaluator's XRPL address when `acceptance.evaluator` is a CAIP-10 account in the `xrpl`
 * namespace; `null` when it is such an account but not a valid classic address on `network`;
 * `undefined` when it is not an XRPL account at all (a DID, another chain).
 */
function evaluatorAccount(
  network: string,
  evaluator: string | undefined,
): string | null | undefined {
  if (!evaluator || evaluator.startsWith("did:") || !evaluator.startsWith("xrpl:"))
    return undefined;
  const address = account(network, evaluator);
  return address && isXrplClassicAddress(address) ? address : null;
}

/** Decides level 3 from an escrow state read from the validated ledger. */
export function checkXrplEscrow(signed: SignedReceipt, state: XrplEscrowState): XrplEscrowResult {
  const { network, amount, asset, payer, payee } = signed.receipt.payment;
  const acc = signed.receipt.acceptance;
  const fail = (detail: string): XrplEscrowResult => ({ status: "fail", detail });
  const payerAddr = account(network, payer);
  const payeeAddr = account(network, payee);
  if (payerAddr === null) return fail(`payment.payer is not an account on ${network}`);
  if (payeeAddr === null) return fail(`payment.payee is not an account on ${network}`);
  const x = state.xrpl ?? { currency: "" };
  const evaluator = acc.mode === "evaluator" ? evaluatorAccount(network, acc.evaluator) : undefined;
  const finishedBy = state.status === "released" ? x.settledBy : undefined;
  const conditional = !!x.condition;
  const window =
    x.cancelAfter === undefined || x.deliveryCloseTime === undefined
      ? undefined
      : x.cancelAfter - x.deliveryCloseTime;
  const problems = [
    state.receiptHash !== signed.receiptHash && "recorded delivery is for a different receipt",
    state.amount !== amount &&
      (state.amount === ""
        ? `escrowed value ${x.value ?? "?"} is not a whole number of 10^-15 units, so no receipt amount can name it`
        : "amount differs"),
    !sameAsset(asset, state) && "asset differs (compared by protocol currency bytes and issuer)",
    payerAddr && state.buyer !== payerAddr && "buyer differs from payment.payer",
    payeeAddr && state.seller !== payeeAddr && "seller differs from payment.payee",
    acc.mode !== "auto" &&
      !conditional &&
      `escrow has no Condition, so release did not need the ${acc.mode}'s acceptance`,
    acc.mode === "auto" &&
      conditional &&
      "escrow needs a fulfillment to release; it cannot auto-release as acceptance.mode auto states",
    acc.mode !== "auto" &&
      window !== undefined &&
      acc.reviewWindowSeconds > window &&
      `acceptance.reviewWindowSeconds ${acc.reviewWindowSeconds} exceeds the ${window} s the ledger left between delivery and CancelAfter`,
    evaluator === null &&
      `acceptance.evaluator ${acc.evaluator} is not a valid XRPL account on ${network}, so it cannot have finished this escrow`,
    evaluator &&
      evaluator === state.seller &&
      "acceptance.evaluator is the seller's own account: a seller finishing its own escrow is not an evaluator's decision",
    evaluator &&
      finishedBy !== undefined &&
      finishedBy !== evaluator &&
      `escrow was finished by ${finishedBy}, not by the evaluator ${evaluator}: the release was not the evaluator's decision`,
  ].filter(Boolean);
  if (problems.length) return fail(`escrow ${state.status}: ${problems.join("; ")}`);
  if (state.status === "refunded" || state.status === "open")
    return fail(`escrow is ${state.status}`);
  if (!payerAddr || !payeeAddr)
    return {
      status: "unavailable",
      detail: "receipt doesn't name both payer and payee, so the parties can't be confirmed",
    };
  if (x.cancelAfter !== undefined && x.deliveryCloseTime === undefined)
    return {
      status: "unavailable",
      detail: "the delivery's ledger close time is unknown, so the review window can't be checked",
    };
  if (acc.mode === "auto")
    return {
      status: "unavailable",
      detail:
        "an unconditional XRPL escrow has no on-ledger review window; auto terms can't be confirmed",
    };
  if (acc.mode === "evaluator" && !evaluator)
    return {
      status: "unavailable",
      detail:
        "acceptance.evaluator is not an XRPL account, so the ledger cannot show it decided (SPEC §7.3: the evaluator must finish the escrow from its own xrpl account)",
    };
  if (state.status === "delivered")
    return {
      status: "pending",
      detail:
        acc.mode === "evaluator"
          ? "delivered; awaiting the evaluator's EscrowFinish"
          : "delivered; awaiting the buyer's fulfillment",
    };
  if (acc.mode === "evaluator" && finishedBy === undefined)
    return {
      status: "unavailable",
      detail: "the ledger history does not show which account finished the escrow",
    };
  const left = window === undefined ? "no CancelAfter" : `${window} s before CancelAfter`;
  const decided =
    acc.mode === "evaluator"
      ? `finished by the evaluator's own account ${evaluator}${x.settlementTx ? ` (EscrowFinish ${x.settlementTx})` : ""}`
      : "the buyer-held condition was fulfilled";
  return {
    status: "pass",
    detail: `escrow finished to the payee; amount, asset, parties and delivery memo match; ${decided} (delivered ${left})`,
  };
}

/** Reads the escrow and decides level 3; incomplete history is `unavailable`, never fail/pass. */
export async function verifyXrplEscrowPayment(
  signed: SignedReceipt,
  getEscrow: (escrowId: string) => Promise<XrplEscrowState>,
): Promise<XrplEscrowResult> {
  let state: XrplEscrowState;
  try {
    state = await getEscrow(signed.receipt.payment.reference);
  } catch (err) {
    const e = err as { name?: string; message?: string };
    const msg = e?.message ?? String(err);
    if (e?.name === "XrplHistoryIncompleteError")
      return { status: "unavailable", detail: `could not be checked: ${msg}` };
    if (/^escrow \S+ not found$/.test(msg) || /^EscrowCreate for \S+ not found/.test(msg))
      return { status: "fail", detail: msg };
    return { status: "unavailable", detail: `could not be checked: ${msg}` };
  }
  return checkXrplEscrow(signed, state);
}
