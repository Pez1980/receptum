import {
  checkPayeeBinding,
  sha256File,
  sha256Hex,
  verifySignedReceipt,
  type BindingVerifier,
  type SignedReceipt,
} from "@receptum/core";
import {
  anchorCalldata,
  evmBindingVerifier,
  NETWORKS,
  receptumEscrowAbi,
  receptumEscrowDeployedBytecode,
  parseEscrowId,
} from "@receptum/adapter-evm";
import { StellarAnchor } from "@receptum/adapter-stellar";
import {
  XrplAnchor,
  XrplEscrowRail,
  xrplBindingVerifier,
  xrplOnlineBindingVerifier,
} from "@receptum/adapter-xrpl";
import {
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  type Hex,
} from "viem";
import { Client } from "xrpl";

/** pending = genuine but not yet final (e.g. escrow delivered, awaiting acceptance). */
export type CheckStatus = "pass" | "fail" | "pending" | "skipped";

export interface Check {
  /**
   * 1 = file ↔ receipt, 2 = receipt ↔ seller, 2.5 = seller ↔ payee (account binding, SPEC §4.1),
   * 3 = receipt ↔ settlement/anchor (SPEC §6).
   */
  level: 1 | 2 | 2.5 | 3;
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface VerifyReport {
  /** Nothing failed. */
  ok: boolean;
  /** Nothing failed AND the payment itself was verified on its rail (not just anchored). */
  complete: boolean;
  receiptHash: string;
  seller: string;
  checks: Check[];
}

const XRPL_TESTNET_WSS = "wss://s.altnet.rippletest.net:51233";

/** Levels 1–2, offline: does the file match, and did the seller sign this receipt? */
export async function verifyOffline(
  signed: SignedReceipt,
  file?: string | Uint8Array,
): Promise<Check[]> {
  const checks: Check[] = [];
  if (file !== undefined) {
    const hash = typeof file === "string" ? await sha256File(file) : sha256Hex(file);
    const expected = signed.receipt.outputSha256;
    checks.push({
      level: 1,
      name: "File matches receipt",
      status:
        hash === expected ? "pass" : signed.receipt.inputSha256.includes(hash) ? "fail" : "fail",
      detail:
        hash === expected
          ? `SHA-256 ${hash} = outputSha256`
          : signed.receipt.inputSha256.includes(hash)
            ? "file is one of the inputs, not the delivered output"
            : `SHA-256 ${hash} ≠ outputSha256 ${expected}`,
    });
  }
  const sig = verifySignedReceipt(signed);
  checks.push({
    level: 2,
    name: "Seller signature",
    status: sig.ok ? "pass" : "fail",
    detail: sig.ok ? `signed by ${sig.seller}` : sig.reason,
  });
  return checks;
}

function evmClient(network: string) {
  const net = NETWORKS[network as keyof typeof NETWORKS];
  if (!net) return null;
  return { net, client: createPublicClient({ chain: net.chain, transport: http() }) };
}

/**
 * Parses a CAIP-10 account and requires it to be on `network` (e.g. `eip155:84532:0xabc…`).
 * Returns the bare account, or null when the account names another network.
 */
export function accountOn(network: string, caip10: string | undefined): string | null | undefined {
  if (caip10 === undefined) return undefined;
  const i = caip10.lastIndexOf(":");
  if (i <= 0 || caip10.slice(0, i) !== network) return null;
  return caip10.slice(i + 1);
}
const sameAddr = (a?: string | null, b?: string | null) =>
  !!a && !!b && getAddress(a) === getAddress(b);
const GENUINE_ESCROW_CODE = keccak256(receptumEscrowDeployedBytecode);

/**
 * ReceptumEscrow deployments published by the project (see packages/adapter-evm/E2E_RESULTS.md).
 * Matching runtime code alone doesn't prove a contract wasn't deployed with forged storage, so only
 * these — or deployments the caller explicitly trusts — can yield a complete verification.
 */
export const TRUSTED_ESCROWS: Record<string, readonly string[]> = {
  "eip155:5042002": ["0x20d69c6c647559f48a7e6b0a3f922e99a4068f16"],
};

async function withXrpl<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(XRPL_TESTNET_WSS);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}

/** Level 3 for the payment rail named in the receipt. */
async function verifyPayment(signed: SignedReceipt, trustedEscrows: string[] = []): Promise<Check> {
  const { rail, network, reference, amount, asset, payer, payee } = signed.receipt.payment;
  const name = `Payment on ${network}`;
  const fail = (detail: string): Check => ({ level: 3, name, status: "fail", detail });
  const pending = (detail: string): Check => ({ level: 3, name, status: "pending", detail });
  const pass = (detail: string): Check => ({ level: 3, name, status: "pass", detail });
  const payerAddr = accountOn(network, payer);
  const payeeAddr = accountOn(network, payee);
  if (payerAddr === null) return fail(`payment.payer is not an account on ${network}`);
  if (payeeAddr === null) return fail(`payment.payee is not an account on ${network}`);
  try {
    if (rail === "escrow:receptum-evm") {
      const evm = evmClient(network);
      if (!evm)
        return { level: 3, name, status: "skipped", detail: `unsupported network ${network}` };
      const ref = parseEscrowId(reference);
      if (ref.network !== network)
        return fail(`escrow reference is on ${ref.network}, receipt says ${network}`);
      const code = await evm.client.getCode({ address: ref.contract });
      if (!code || keccak256(code) !== GENUINE_ESCROW_CODE)
        return fail("referenced contract is not ReceptumEscrow");
      const [buyer, seller, evaluator, token, escrowAmount, , reviewWindow, , status, committed] =
        await evm.client.readContract({
          address: ref.contract,
          abi: receptumEscrowAbi,
          functionName: "escrows",
          args: [ref.id],
        });
      const statusName = ["none", "open", "delivered", "released", "refunded"][status] ?? "unknown";
      const acc = signed.receipt.acceptance;
      const noEvaluator = /^0x0{40}$/i.test(evaluator);
      const problems = [
        committed.slice(2).toLowerCase() !== signed.receiptHash && "committed receiptHash differs",
        escrowAmount.toString() !== amount && "amount differs",
        !sameAddr(token, asset) && "token differs from payment.asset",
        payerAddr && !sameAddr(buyer, payerAddr) && "buyer differs from payment.payer",
        payeeAddr && !sameAddr(seller, payeeAddr) && "seller differs from payment.payee",
        BigInt(reviewWindow) !== BigInt(acc.reviewWindowSeconds) &&
          "review window differs from acceptance.reviewWindowSeconds",
        acc.mode === "evaluator" &&
          (noEvaluator || !sameAddr(evaluator, accountOn(network, acc.evaluator))) &&
          "evaluator differs from acceptance.evaluator",
        acc.mode !== "evaluator" &&
          !noEvaluator &&
          "escrow has an evaluator the receipt doesn't declare",
      ].filter(Boolean);
      if (problems.length) return fail(`escrow ${statusName}: ${problems.join("; ")}`);
      if (statusName !== "released" && statusName !== "delivered")
        return fail(`escrow is ${statusName}, not released`);
      const trusted = [...(TRUSTED_ESCROWS[network] ?? []), ...trustedEscrows].some((t) =>
        sameAddr(t, ref.contract),
      );
      if (!trusted)
        return pending(
          "ReceptumEscrow code, but this deployment isn't in the trusted registry (pass --trust-escrow to accept it)",
        );
      if (!payeeAddr)
        return pending("receipt does not name a payee, so the recipient can't be confirmed");
      if (statusName === "delivered")
        return pending(
          "delivery committed; funds still held awaiting acceptance or the review window",
        );
      return pass("escrow released to the payee; committed receiptHash and terms match");
    }
    if (rail.startsWith("x402:") && network.startsWith("eip155:")) {
      const evm = evmClient(network);
      if (!evm)
        return { level: 3, name, status: "skipped", detail: `unsupported network ${network}` };
      if (!payeeAddr)
        return pending("receipt does not name a payee, so the recipient can't be confirmed");
      const tx = await evm.client.getTransactionReceipt({ hash: reference as Hex });
      if (tx.status !== "success") return fail("settlement transaction reverted");
      const paid = tx.logs.some((log) => {
        if (!sameAddr(log.address, asset)) return false;
        try {
          const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
          return (
            ev.eventName === "Transfer" &&
            ev.args.value.toString() === amount &&
            sameAddr(ev.args.to, payeeAddr) &&
            (!payerAddr || sameAddr(ev.args.from, payerAddr))
          );
        } catch {
          return false;
        }
      });
      return paid
        ? pass(`${amount} base units paid to ${payeeAddr} in block ${tx.blockNumber}`)
        : fail("no transfer of that amount to the payee in the settlement transaction");
    }
    if (rail === "escrow:xrpl" && network === "xrpl:1") {
      const state = await withXrpl((client) => new XrplEscrowRail({ client }).getEscrow(reference));
      const problems = [
        state.receiptHash !== signed.receiptHash && "recorded delivery is for a different receipt",
        state.amount !== amount && "amount differs",
        state.asset !== asset && "asset differs",
        payerAddr && state.buyer !== payerAddr && "buyer differs from payment.payer",
        payeeAddr && state.seller !== payeeAddr && "seller differs from payment.payee",
      ].filter(Boolean);
      if (problems.length) return fail(`escrow ${state.status}: ${problems.join("; ")}`);
      if (!payerAddr || !payeeAddr)
        return pending(
          "receipt doesn't name both payer and payee, so the parties can't be confirmed",
        );
      if (state.status === "released")
        return pass("escrow finished to the payee; amount, asset, parties and delivery memo match");
      if (state.status === "delivered")
        return pending("delivered; awaiting the buyer's fulfillment");
      return fail(`escrow is ${state.status}`);
    }
    return {
      level: 3,
      name,
      status: "skipped",
      detail: `no settlement check for rail ${rail}; only its anchor can be checked`,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Level 3 for an anchor reference: `<caip2>:<tx>`, e.g. `eip155:5042002:0x…`, `xrpl:1:ABC…`, `stellar:testnet:abc…`. */
async function verifyAnchor(signed: SignedReceipt, anchorRef: string): Promise<Check> {
  const i = anchorRef.lastIndexOf(":");
  const network = anchorRef.slice(0, i);
  const reference = anchorRef.slice(i + 1);
  const name = `Anchor on ${network}`;
  try {
    if (network.startsWith("eip155:")) {
      const evm = evmClient(network);
      if (!evm)
        return { level: 3, name, status: "skipped", detail: `unsupported network ${network}` };
      const tx = await evm.client.getTransaction({ hash: reference as Hex });
      const mined = await evm.client.getTransactionReceipt({ hash: reference as Hex });
      if (mined.status !== "success")
        return { level: 3, name, status: "fail", detail: "anchor transaction reverted" };
      const ok = tx.input.toLowerCase() === anchorCalldata(signed.receiptHash).toLowerCase();
      return {
        level: 3,
        name,
        status: ok ? "pass" : "fail",
        detail: ok
          ? `receiptHash anchored in ${reference}`
          : "transaction does not anchor this receiptHash",
      };
    }
    if (network === "xrpl:1") {
      const client = new Client(XRPL_TESTNET_WSS);
      await client.connect();
      try {
        const found = await new XrplAnchor({ client }).find(signed.receiptHash, { reference });
        return {
          level: 3,
          name,
          status: found ? "pass" : "fail",
          detail: found
            ? `memo anchored ${found.anchoredAt}`
            : "no receipt memo in that transaction",
        };
      } finally {
        await client.disconnect();
      }
    }
    if (network === "stellar:testnet") {
      const found = await new StellarAnchor().find(signed.receiptHash, { reference });
      return {
        level: 3,
        name,
        status: found ? "pass" : "fail",
        detail: found ? `MEMO_HASH anchored ${found.anchoredAt}` : "no MEMO_HASH for this receipt",
      };
    }
    return { level: 3, name, status: "skipped", detail: `unsupported network ${network}` };
  } catch (err) {
    return {
      level: 3,
      name,
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Offline binding verifiers for every namespace the verifier supports (stellar is built in). */
export const BINDING_VERIFIERS: readonly BindingVerifier[] = [
  evmBindingVerifier,
  xrplBindingVerifier,
];

/**
 * Level 2.5: does a valid account binding prove the seller controls `payment.payee`?
 * pass = valid binding; fail = bindings present but none valid; pending = no binding at all
 * (legacy receipt) — `skipped` instead when `allowUnbound`. Online, XRPL keys are checked
 * against the account's current master/regular key.
 */
export async function verifyBinding(
  signed: SignedReceipt,
  options: { offline?: boolean; allowUnbound?: boolean } = {},
): Promise<Check> {
  const name = "Seller controls payee";
  const payee = signed.receipt.payment.payee;
  if (!payee) return { level: 2.5, name, status: "skipped", detail: "receipt names no payee" };
  if (!signed.bindings?.length)
    return options.allowUnbound
      ? {
          level: 2.5,
          name,
          status: "skipped",
          detail: "no account binding (allowed: --allow-unbound)",
        }
      : {
          level: 2.5,
          name,
          status: "pending",
          detail: "no account binding: nothing proves the seller controls the payee",
        };
  const verifiers = [...BINDING_VERIFIERS];
  let mode = "offline";
  try {
    if (!options.offline && payee.startsWith("xrpl:1:")) {
      const address = payee.slice("xrpl:1:".length);
      verifiers.unshift(await withXrpl((client) => xrplOnlineBindingVerifier(client, address)));
      mode = "online, current account keys";
    }
  } catch (err) {
    return {
      level: 2.5,
      name,
      status: "fail",
      detail: `could not load XRPL account keys: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const res = checkPayeeBinding(signed, { verifiers });
  return res.ok
    ? {
        level: 2.5,
        name,
        status: "pass",
        detail: `${res.binding.statement.did} ↔ ${payee}: ${res.detail} (${mode})`,
      }
    : { level: 2.5, name, status: "fail", detail: res.reason };
}

export interface VerifyOptions {
  file?: string | Uint8Array;
  /** Anchor references to check, `<caip2>:<tx>`. */
  anchors?: string[];
  /** Skip all network checks. */
  offline?: boolean;
  /** Extra ReceptumEscrow deployments to trust, in addition to TRUSTED_ESCROWS. */
  trustedEscrows?: string[];
  /**
   * Accept receipts without an account binding as complete (legacy receipts). Invalid bindings
   * still fail.
   */
  allowUnbound?: boolean;
}

/** Runs every applicable check. `ok` is true when nothing failed. */
export async function verify(
  signed: SignedReceipt,
  options: VerifyOptions = {},
): Promise<VerifyReport> {
  const checks = await verifyOffline(signed, options.file);
  const signatureOk = checks.some((c) => c.level === 2 && c.status === "pass");
  const binding: Check = signatureOk
    ? await verifyBinding(signed, {
        ...(options.offline ? { offline: true } : {}),
        ...(options.allowUnbound ? { allowUnbound: true } : {}),
      })
    : {
        level: 2.5,
        name: "Seller controls payee",
        status: "skipped",
        detail: "receipt signature is invalid",
      };
  checks.push(binding);
  if (!options.offline) {
    checks.push(await verifyPayment(signed, options.trustedEscrows));
    for (const a of options.anchors ?? []) checks.push(await verifyAnchor(signed, a));
  }
  const ok = checks.every((c) => c.status !== "fail");
  const payment = checks.find((c) => c.level === 3 && c.name.startsWith("Payment"));
  return {
    ok,
    // A payee that the seller hasn't proven it controls is not a complete verification.
    complete: ok && payment?.status === "pass" && binding.status !== "pending",
    receiptHash: signed.receiptHash,
    seller: signed.receipt.seller.id,
    checks,
  };
}
