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
 *   · `evaluator`: same ledger rules, but the evaluator's identity can't be proven — possessing a
 *     fulfillment doesn't show who decided — so the check is at best `unavailable`.
 *   · `auto`: a conditional escrow can't auto-release, so it fails; an unconditional one has no
 *     on-ledger review window, so it is `unavailable`.
 * - History that could not be read in full (`XrplHistoryIncompleteError`) is `unavailable`.
 */
import type { SignedReceipt } from "@receptum/core";
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
  const conditional = !!x.condition;
  const window =
    x.cancelAfter === undefined || x.deliveryCloseTime === undefined
      ? undefined
      : x.cancelAfter - x.deliveryCloseTime;
  const problems = [
    state.receiptHash !== signed.receiptHash && "recorded delivery is for a different receipt",
    state.amount !== amount && "amount differs",
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
  if (acc.mode === "evaluator")
    return {
      status: "unavailable",
      detail:
        "the ledger shows a fulfillment was needed, not who held it: acceptance.evaluator can't be confirmed on XRPL",
    };
  if (state.status === "delivered")
    return { status: "pending", detail: "delivered; awaiting the buyer's fulfillment" };
  const left = window === undefined ? "no CancelAfter" : `${window} s before CancelAfter`;
  return {
    status: "pass",
    detail: `escrow finished to the payee; amount, asset, parties, delivery memo and buyer-held condition match (delivered ${left})`,
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
