import { sha256File, sha256Hex, verifySignedReceipt, type SignedReceipt } from "@receptum/core";
import {
  anchorCalldata,
  NETWORKS,
  receptumEscrowAbi,
  receptumEscrowDeployedBytecode,
  parseEscrowId,
} from "@receptum/adapter-evm";
import { StellarAnchor } from "@receptum/adapter-stellar";
import { XrplAnchor, XrplEscrowRail } from "@receptum/adapter-xrpl";
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
  /** 1 = file ↔ receipt, 2 = receipt ↔ seller, 3 = receipt ↔ settlement/anchor (SPEC §6). */
  level: 1 | 2 | 3;
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

const bare = (caip10?: string) => caip10?.split(":").pop();
const sameAddr = (a?: string, b?: string) => !!a && !!b && getAddress(a) === getAddress(b);
const GENUINE_ESCROW_CODE = keccak256(receptumEscrowDeployedBytecode);

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
async function verifyPayment(signed: SignedReceipt): Promise<Check> {
  const { rail, network, reference, amount, asset, payer, payee } = signed.receipt.payment;
  const name = `Payment on ${network}`;
  const fail = (detail: string): Check => ({ level: 3, name, status: "fail", detail });
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
        return fail("referenced contract is not a genuine ReceptumEscrow deployment");
      const [buyer, seller, , token, escrowAmount, , , , status, committed] =
        await evm.client.readContract({
          address: ref.contract,
          abi: receptumEscrowAbi,
          functionName: "escrows",
          args: [ref.id],
        });
      const statusName = ["none", "open", "delivered", "released", "refunded"][status] ?? "unknown";
      const problems = [
        committed.slice(2).toLowerCase() !== signed.receiptHash && "committed receiptHash differs",
        escrowAmount.toString() !== amount && "amount differs",
        !sameAddr(token, asset) && "token differs from payment.asset",
        payer && !sameAddr(buyer, bare(payer)) && "buyer differs from payment.payer",
        payee && !sameAddr(seller, bare(payee)) && "seller differs from payment.payee",
      ].filter(Boolean);
      if (problems.length) return fail(`escrow ${statusName}: ${problems.join("; ")}`);
      if (statusName === "released")
        return {
          level: 3,
          name,
          status: "pass",
          detail: `escrow released to the seller; committed receiptHash matches`,
        };
      if (statusName === "delivered")
        return {
          level: 3,
          name,
          status: "pending",
          detail: "delivery committed; funds still held awaiting acceptance or the review window",
        };
      return fail(`escrow is ${statusName}, not released`);
    }
    if (rail.startsWith("x402:") && network.startsWith("eip155:")) {
      const evm = evmClient(network);
      if (!evm)
        return { level: 3, name, status: "skipped", detail: `unsupported network ${network}` };
      if (!payee) return fail("receipt does not name a payee, so the recipient can't be checked");
      const tx = await evm.client.getTransactionReceipt({ hash: reference as Hex });
      if (tx.status !== "success") return fail("settlement transaction reverted");
      const from = bare(payer);
      const paid = tx.logs.some((log) => {
        if (!sameAddr(log.address, asset)) return false;
        try {
          const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
          return (
            ev.eventName === "Transfer" &&
            ev.args.value.toString() === amount &&
            sameAddr(ev.args.to, bare(payee)) &&
            (!from || sameAddr(ev.args.from, from))
          );
        } catch {
          return false;
        }
      });
      return paid
        ? {
            level: 3,
            name,
            status: "pass",
            detail: `${amount} base units paid to ${bare(payee)} in block ${tx.blockNumber}`,
          }
        : fail("no transfer of that amount to the payee in the settlement transaction");
    }
    if (rail === "escrow:xrpl" && network === "xrpl:1") {
      const state = await withXrpl((client) => new XrplEscrowRail({ client }).getEscrow(reference));
      if (state.receiptHash !== signed.receiptHash)
        return fail(`escrow ${state.status}; recorded delivery is for a different receipt`);
      if (state.status === "released")
        return {
          level: 3,
          name,
          status: "pass",
          detail: "escrow finished to the seller; delivery memo matches",
        };
      if (state.status === "delivered")
        return {
          level: 3,
          name,
          status: "pending",
          detail: "delivered; awaiting the buyer's fulfillment",
        };
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

export interface VerifyOptions {
  file?: string | Uint8Array;
  /** Anchor references to check, `<caip2>:<tx>`. */
  anchors?: string[];
  /** Skip all network checks. */
  offline?: boolean;
}

/** Runs every applicable check. `ok` is true when nothing failed. */
export async function verify(
  signed: SignedReceipt,
  options: VerifyOptions = {},
): Promise<VerifyReport> {
  const checks = await verifyOffline(signed, options.file);
  if (!options.offline) {
    checks.push(await verifyPayment(signed));
    for (const a of options.anchors ?? []) checks.push(await verifyAnchor(signed, a));
  }
  const ok = checks.every((c) => c.status !== "fail");
  const payment = checks.find((c) => c.level === 3 && c.name.startsWith("Payment"));
  return {
    ok,
    complete: ok && payment?.status === "pass",
    receiptHash: signed.receiptHash,
    seller: signed.receipt.seller.id,
    checks,
  };
}
