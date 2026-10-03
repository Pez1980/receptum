/**
 * Level 3 on Solana (SPEC §7.1, §7.3): `x402:exact` settlements, `escrow:receptum-solana` escrows
 * and `anchor:solana` memo anchors.
 *
 * Every lookup first checks that the RPC serves the receipt's cluster (its genesis hash begins
 * with the CAIP-2 reference); otherwise, and on any transport or RPC error, the check is
 * `unavailable` — never a pass and never a failure.
 */
import type { SignedReceipt } from "@receptum/core";
import {
  anchorMemo,
  BPF_LOADER_UPGRADEABLE_ID,
  decodeEscrowAccount,
  escrowAddress,
  findTokenTransfer,
  getAccount,
  getParsedTransaction,
  isSolanaAddress,
  isSolanaNetwork,
  isSolanaSignature,
  parseSolanaEscrowId,
  programDataAddress,
  programDataHash,
  RECEPTUM_SOLANA_PROGRAM_HASH,
  servesNetwork,
  SOLANA_RPC_ENDPOINTS,
  solanaJsonRpc,
  topLevelMemos,
  type SolanaRpc,
} from "@receptum/adapter-solana";

export type SolanaCheckStatus = "pass" | "fail" | "pending" | "unavailable";
export interface SolanaCheckResult {
  status: SolanaCheckStatus;
  detail: string;
}

export interface SolanaVerifyOptions {
  /** Override the JSON-RPC transport (tests, private nodes). */
  rpc?: SolanaRpc;
  /** CAIP-2 → JSON-RPC URL; merged over the public endpoints. */
  rpcs?: Record<string, string>;
}

const fail = (detail: string): SolanaCheckResult => ({ status: "fail", detail });
const pass = (detail: string): SolanaCheckResult => ({ status: "pass", detail });
const pending = (detail: string): SolanaCheckResult => ({ status: "pending", detail });
const unavailable = (detail: string): SolanaCheckResult => ({ status: "unavailable", detail });
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const account = (network: string, caip10: string | undefined): string | null | undefined => {
  if (caip10 === undefined) return undefined;
  const i = caip10.lastIndexOf(":");
  return i > 0 && caip10.slice(0, i) === network ? caip10.slice(i + 1) : null;
};

/** The RPC for `network`, after checking it serves that cluster; or an `unavailable` result. */
async function connect(
  network: string,
  options: SolanaVerifyOptions,
): Promise<SolanaRpc | SolanaCheckResult> {
  let rpc = options.rpc;
  if (!rpc) {
    const url = { ...SOLANA_RPC_ENDPOINTS, ...options.rpcs }[network];
    if (!url) return unavailable(`no Solana RPC endpoint configured for ${network}`);
    rpc = solanaJsonRpc(url);
  }
  try {
    if (!(await servesNetwork(rpc, network)))
      return unavailable(`the RPC does not serve ${network} (genesis hash mismatch)`);
  } catch (err) {
    return unavailable(`Solana RPC unavailable: ${errorText(err)}`);
  }
  return rpc;
}

const isResult = (x: unknown): x is SolanaCheckResult =>
  typeof x === "object" && x !== null && "status" in x && "detail" in x;

export interface SolanaPayment {
  network: string;
  asset: string;
  amount: string;
  reference: string;
  payee?: string;
  payer?: string;
}

/**
 * `x402:exact` on `solana:*` (SPEC §7.3): the transaction at `payment.reference` is confirmed or
 * finalized without error and moves exactly `payment.amount` of mint `payment.asset` from a
 * token account owned by the payer to one owned by the payee (`transferChecked`), and the
 * payee's balance of that mint rose by exactly that amount.
 */
export async function verifySolanaX402Payment(
  payment: SolanaPayment,
  options: SolanaVerifyOptions = {},
): Promise<SolanaCheckResult> {
  const { network, reference, amount, asset } = payment;
  if (!isSolanaNetwork(network)) return fail(`${network} is not a Solana network`);
  if (!isSolanaSignature(reference))
    return fail("payment.reference is not a Solana transaction signature (base58, 64 bytes)");
  if (!isSolanaAddress(asset)) return fail("payment.asset must be the SPL token mint address");
  if (!/^(0|[1-9][0-9]*)$/.test(amount))
    return fail("payment.amount must be an integer (token base units)");
  const payee = account(network, payment.payee);
  const payer = account(network, payment.payer);
  if (payee === null || (payee !== undefined && !isSolanaAddress(payee)))
    return fail(`payment.payee is not an account on ${network}`);
  if (payer === null || (payer !== undefined && !isSolanaAddress(payer)))
    return fail(`payment.payer is not an account on ${network}`);
  if (!payee)
    return unavailable("receipt does not name a payee, so the recipient can't be confirmed");
  const rpc = await connect(network, options);
  if (isResult(rpc)) return rpc;
  let found: Awaited<ReturnType<typeof getParsedTransaction>>;
  try {
    found = await getParsedTransaction(rpc, reference);
  } catch (err) {
    return unavailable(`transaction lookup unavailable: ${errorText(err)}`);
  }
  if (!found)
    return unavailable(`transaction ${reference} not found (not confirmed yet, or no history)`);
  if (found.tx.transaction.signatures[0] !== reference)
    return fail("the RPC returned a different transaction");
  const m = findTokenTransfer(found.tx, {
    mint: asset,
    amount,
    payee,
    ...(payer ? { payer } : {}),
  });
  return m.ok ? pass(`${m.detail} in slot ${found.tx.slot} (${found.commitment})`) : fail(m.reason);
}

/** `anchor:solana` (SPEC §7.1): a successful transaction with the memo `receptum/1:<hash>`. */
export async function verifySolanaAnchor(
  receiptHash: string,
  network: string,
  reference: string,
  options: SolanaVerifyOptions = {},
): Promise<SolanaCheckResult> {
  if (!isSolanaNetwork(network)) return fail(`${network} is not a Solana network`);
  if (!isSolanaSignature(reference)) return fail("anchor transaction signature is malformed");
  const rpc = await connect(network, options);
  if (isResult(rpc)) return rpc;
  let found: Awaited<ReturnType<typeof getParsedTransaction>>;
  try {
    found = await getParsedTransaction(rpc, reference);
  } catch (err) {
    return unavailable(`anchor lookup unavailable: ${errorText(err)}`);
  }
  if (!found) return fail("anchor transaction not found or not confirmed");
  const { tx, commitment } = found;
  if (tx.transaction.signatures[0] !== reference)
    return fail("the RPC returned a different transaction");
  if (!tx.meta || tx.meta.err !== null) return fail("anchor transaction did not succeed");
  return topLevelMemos(tx).includes(anchorMemo(receiptHash))
    ? pass(`memo anchored in slot ${tx.slot} (${commitment})`)
    : fail("no receptum/1 memo for this receiptHash in that transaction");
}

/**
 * `escrow:receptum-solana` (SPEC §7.3): the program at `payment.reference` runs the published
 * `receptum_escrow` build and is immutable; the escrow account it owns commits this receiptHash,
 * its terms match the receipt and it was released to the payee.
 */
export async function verifySolanaEscrowPayment(
  signed: SignedReceipt,
  trusted: readonly string[],
  options: SolanaVerifyOptions = {},
): Promise<SolanaCheckResult> {
  const { network, reference, amount, asset, payer, payee } = signed.receipt.payment;
  let ref: ReturnType<typeof parseSolanaEscrowId>;
  try {
    ref = parseSolanaEscrowId(reference);
  } catch (err) {
    return fail(errorText(err));
  }
  if (ref.network !== network)
    return fail(`escrow reference is on ${ref.network}, receipt says ${network}`);
  const payeeAddr = account(network, payee);
  const payerAddr = account(network, payer);
  if (payeeAddr === null) return fail(`payment.payee is not an account on ${network}`);
  if (payerAddr === null) return fail(`payment.payer is not an account on ${network}`);
  const rpc = await connect(network, options);
  if (isResult(rpc)) return rpc;
  try {
    const program = await getAccount(rpc, ref.programId);
    if (!program || !program.executable || program.owner !== BPF_LOADER_UPGRADEABLE_ID)
      return fail("referenced program is not a deployed upgradeable-loader program");
    const programData = await getAccount(rpc, programDataAddress(program.data));
    if (!programData) return fail("program has no ProgramData account");
    const { hash, upgradeAuthority } = programDataHash(programData.data);
    if (hash !== RECEPTUM_SOLANA_PROGRAM_HASH)
      return fail("referenced program does not run the published receptum_escrow build");
    const acc = await getAccount(rpc, ref.escrow);
    if (!acc || acc.owner !== ref.programId) return fail(`escrow ${ref.escrow} not found`);
    let e: ReturnType<typeof decodeEscrowAccount>;
    try {
      e = decodeEscrowAccount(acc.data);
    } catch (err) {
      return fail(errorText(err));
    }
    if (escrowAddress(e.buyer, e.id, ref.programId).address !== ref.escrow)
      return fail("escrow account is not at its program-derived address");
    const acceptance = signed.receipt.acceptance;
    const problems = [
      e.receiptHash !== signed.receiptHash && "committed receiptHash differs",
      e.amount.toString() !== amount && "amount differs",
      e.mint !== asset && "mint differs from payment.asset",
      payerAddr && e.buyer !== payerAddr && "buyer differs from payment.payer",
      payeeAddr && e.seller !== payeeAddr && "seller differs from payment.payee",
      e.reviewWindowSeconds !== acceptance.reviewWindowSeconds &&
        "review window differs from acceptance.reviewWindowSeconds",
      acceptance.mode === "evaluator" &&
        (!e.evaluator || e.evaluator !== account(network, acceptance.evaluator)) &&
        "evaluator differs from acceptance.evaluator",
      acceptance.mode !== "evaluator" &&
        e.evaluator &&
        "escrow has an evaluator the receipt doesn't declare",
    ].filter(Boolean);
    if (problems.length) return fail(`escrow ${e.status}: ${problems.join("; ")}`);
    if (e.status !== "released" && e.status !== "delivered")
      return fail(`escrow is ${e.status}, not released`);
    if (upgradeAuthority)
      return pending(
        `program is upgradeable (authority ${upgradeAuthority}), so its accounts can't be trusted`,
      );
    if (!trusted.includes(ref.programId))
      return pending(
        "untrusted deployment: receptum_escrow build, but this deployment isn't in the trusted registry (pass --trust-escrow to accept it)",
      );
    if (!payeeAddr)
      return unavailable("receipt does not name a payee, so the recipient can't be confirmed");
    if (e.status === "delivered")
      return pending(
        "delivery committed; funds still held awaiting acceptance or the review window",
      );
    const by = e.settledBy ? `accepted by ${e.settledBy}` : "released after the review window";
    return pass(
      `Solana escrow released to the payee (${by}); committed receiptHash and terms match`,
    );
  } catch (err) {
    return unavailable(`could not be checked: ${errorText(err)}`);
  }
}
