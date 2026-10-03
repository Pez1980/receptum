import { sha256File, sha256Hex, verifySignedReceipt, type SignedReceipt } from "@receptum/core";
import { anchorCalldata, NETWORKS, receptumEscrowAbi, parseEscrowId } from "@receptum/adapter-evm";
import { StellarAnchor } from "@receptum/adapter-stellar";
import { XrplAnchor } from "@receptum/adapter-xrpl";
import { createPublicClient, decodeEventLog, erc20Abi, getAddress, http, type Hex } from "viem";
import { Client } from "xrpl";

export type CheckStatus = "pass" | "fail" | "skipped";

export interface Check {
  /** 1 = file ↔ receipt, 2 = receipt ↔ seller, 3 = receipt ↔ settlement/anchor (SPEC §6). */
  level: 1 | 2 | 3;
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface VerifyReport {
  ok: boolean;
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

/** Level 3 for the payment rail named in the receipt. */
async function verifyPayment(signed: SignedReceipt): Promise<Check> {
  const { rail, network, reference, amount, asset, payer } = signed.receipt.payment;
  const name = `Payment on ${network}`;
  try {
    if (rail === "escrow:receptum-evm") {
      const evm = evmClient(network);
      if (!evm)
        return { level: 3, name, status: "skipped", detail: `unsupported network ${network}` };
      const { contract, id } = parseEscrowId(reference);
      const e = await evm.client.readContract({
        address: contract,
        abi: receptumEscrowAbi,
        functionName: "escrows",
        args: [id],
      });
      const [, , , , escrowAmount, , , , status, committed] = e;
      const statusName = ["none", "open", "delivered", "released", "refunded"][status] ?? "unknown";
      const hashOk = committed.slice(2).toLowerCase() === signed.receiptHash;
      const ok =
        hashOk &&
        escrowAmount.toString() === amount &&
        (statusName === "released" || statusName === "delivered");
      return {
        level: 3,
        name,
        status: ok ? "pass" : "fail",
        detail: `escrow ${statusName}; committed receiptHash ${hashOk ? "matches" : "differs"}; amount ${escrowAmount}`,
      };
    }
    if (rail.startsWith("x402:") && network.startsWith("eip155:")) {
      const evm = evmClient(network);
      if (!evm)
        return { level: 3, name, status: "skipped", detail: `unsupported network ${network}` };
      const tx = await evm.client.getTransactionReceipt({ hash: reference as Hex });
      if (tx.status !== "success")
        return { level: 3, name, status: "fail", detail: "settlement transaction reverted" };
      const from = payer?.split(":").pop();
      const paid = tx.logs.some((log) => {
        if (getAddress(log.address) !== getAddress(asset)) return false;
        try {
          const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
          return (
            ev.eventName === "Transfer" &&
            ev.args.value.toString() === amount &&
            (!from || getAddress(ev.args.from) === getAddress(from))
          );
        } catch {
          return false;
        }
      });
      return {
        level: 3,
        name,
        status: paid ? "pass" : "fail",
        detail: paid
          ? `settled ${amount} base units in block ${tx.blockNumber}`
          : "no matching token transfer in the settlement transaction",
      };
    }
    return {
      level: 3,
      name,
      status: "skipped",
      detail: `rail ${rail} is verified through its anchor; pass --anchor`,
    };
  } catch (err) {
    return {
      level: 3,
      name,
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    };
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
  return {
    ok: checks.every((c) => c.status !== "fail"),
    receiptHash: signed.receiptHash,
    seller: signed.receipt.seller.id,
    checks,
  };
}
