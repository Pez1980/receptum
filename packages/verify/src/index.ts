import {
  checkPayeeBinding,
  isCaip2,
  networkClass,
  type NetworkClass,
  JsonInputError,
  parseStrictJsonBytes,
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
import {
  RECEPTUM_SOROBAN_WASM_HASH,
  SOROBAN_ESCROW_RAIL,
  STELLAR_ESCROW_RAIL,
  StellarAnchor,
  StellarClaimableEscrowRail,
  SorobanRpcClient,
  stellarNetwork,
  findSacTransfer,
  parseEscrowId as parseStellarEscrowId,
  parseSorobanEscrowId,
  tokenContractId,
} from "@receptum/adapter-stellar";
import {
  parseEscrowId as parseXrplEscrowId,
  parseReceiptMemos,
  XRPL_ENDPOINTS,
  XrplEscrowRail,
  xrplBindingVerifier,
  xrplOnlineBindingVerifier,
} from "@receptum/adapter-xrpl";
import { createPublicClient, getAddress, http, keccak256, type Hex } from "viem";
import { Client } from "xrpl";
import { erc20TransferMatches } from "./evm-transfer.js";
import { verifyXrplEscrowPayment } from "./xrpl-escrow.js";
import { verifyXrplX402Payment } from "./xrpl-x402.js";

/**
 * pass = confirmed; fail = the evidence contradicts the receipt (or the receipt breaks a MUST);
 * pending = genuine but not yet final (e.g. escrow delivered, awaiting acceptance);
 * unavailable = the check could not be performed (unsupported rail or network, RPC/network error,
 * account not found, non-validated ledger); skipped = not requested or not applicable.
 * SPEC §6: only pass and an allowed skip count toward VERIFIED; fail means NOT VERIFIED.
 */
export type CheckStatus = "pass" | "fail" | "pending" | "skipped" | "unavailable";

export type Verdict = "VERIFIED" | "PARTIALLY VERIFIED" | "NOT VERIFIED";

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
  /** SPEC §6 verdict. */
  verdict: Verdict;
  /** Nothing failed. */
  ok: boolean;
  /** verdict === "VERIFIED". */
  complete: boolean;
  /** When not VERIFIED and nothing failed: each missing piece that prevented VERIFIED. */
  missing: string[];
  receiptHash: string;
  seller: string;
  /** `payment.network` of the receipt (CAIP-2). */
  network?: string;
  /**
   * `mainnet`, `testnet` or `unknown`: lets every consumer label mainnet receipts distinctly
   * (a testnet receipt proves nothing about real money).
   */
  networkClass: NetworkClass;
  checks: Check[];
}

/** Stellar networks the verifier reads (testnet and pubnet; read-only, so no opt-in). */
const STELLAR_IDS = ["stellar:testnet", "stellar:pubnet"];
/** XRPL networks with a public WebSocket endpoint (testnet `xrpl:1`, mainnet `xrpl:0`). */
const xrplWss = (network: string) => XRPL_ENDPOINTS[network]?.[0];

/**
 * Rails that commit `receiptHash` themselves (SPEC §7). Every other rail (e.g. x402) needs a
 * mined anchor for level 3 to pass.
 */
export const COMMITTING_RAILS: readonly string[] = [
  "escrow:receptum-evm",
  SOROBAN_ESCROW_RAIL,
  "escrow:xrpl",
  STELLAR_ESCROW_RAIL,
];

const FILE_CHECK = "File matches receipt";
const PAYMENT_CHECK = "Payment on ";
const COMMIT_CHECK = "receiptHash committed on-chain";

/** Levels 1–2, offline: does the file match, and did the seller sign this receipt? */
export async function verifyOffline(
  signed: SignedReceipt,
  file?: string | Uint8Array,
): Promise<Check[]> {
  const checks: Check[] = [];
  const receipt = (signed as Partial<SignedReceipt> | null)?.receipt;
  if (file === undefined) {
    checks.push({
      level: 1,
      name: FILE_CHECK,
      status: "skipped",
      detail: "no delivered file given",
    });
  } else {
    const hash = typeof file === "string" ? await sha256File(file) : sha256Hex(file);
    const expected = receipt?.outputSha256;
    const inputs = Array.isArray(receipt?.inputSha256) ? receipt.inputSha256 : [];
    checks.push({
      level: 1,
      name: FILE_CHECK,
      status: hash === expected ? "pass" : "fail",
      detail:
        hash === expected
          ? `SHA-256 ${hash} = outputSha256`
          : inputs.includes(hash)
            ? "file is one of the inputs, not the delivered output"
            : `SHA-256 ${hash} ≠ outputSha256 ${String(expected)}`,
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

class Unavailable extends Error {}

function evmClient(network: string) {
  const net = NETWORKS[network as keyof typeof NETWORKS];
  if (!net) return null;
  return { net, client: createPublicClient({ chain: net.chain, transport: http() }) };
}

/** SPEC §7.3: the RPC's chain id MUST equal the CAIP-2 reference, or nothing can be checked. */
async function assertChain(client: { getChainId(): Promise<number> }, network: string) {
  const want = Number(network.slice("eip155:".length));
  const got = await client.getChainId();
  if (got !== want) throw new Unavailable(`RPC serves chain ${got}, expected ${want}`);
}

const EVM_TX = /^0x[0-9a-fA-F]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// Errors that mean the chain contradicts the receipt rather than that it couldn't be asked.
const CONTRADICTIONS = [
  /^unknown escrow/,
  /^escrow \S+ not found$/,
  /^EscrowCreate for \S+ not found/,
  /not a ReceptumEscrow record/,
  // Soroban: no contract instance at the reference (as missing EVM code, SPEC §7.3).
  /^contract \S+ not found$/,
  // Claimable balance without exactly the Receptum claimant shape (SPEC §7.5).
  /^not a Receptum escrow/,
];

/** SPEC §7.5: a claimable-balance reference is the balance id, exactly (hex or `B…` strkey). */
const CLAIMABLE_REFERENCE = /^(?:00000000[0-9A-Fa-f]{64}|B[A-Z2-7]{57})$/;

/** Maps an exception from an online check to fail (contradiction) or unavailable (SPEC §6). */
function fromError(level: Check["level"], name: string, err: unknown): Check {
  const e = err as { name?: string; shortMessage?: string; message?: string };
  const msg = e?.shortMessage ?? e?.message ?? String(err);
  if (e?.name === "XrplHistoryIncompleteError")
    return { level, name, status: "unavailable", detail: `could not be checked: ${msg}` };
  if (e?.name === "TransactionNotFoundError" || e?.name === "TransactionReceiptNotFoundError")
    return { level, name, status: "fail", detail: "transaction not found or not mined" };
  if (!(err instanceof Unavailable) && CONTRADICTIONS.some((p) => p.test(msg)))
    return { level, name, status: "fail", detail: msg };
  return { level, name, status: "unavailable", detail: `could not be checked: ${msg}` };
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
const sameAddr = (a?: string | null, b?: string | null) => {
  try {
    return !!a && !!b && getAddress(a) === getAddress(b);
  } catch {
    return false; // not an EVM address (e.g. a Soroban contract id passed to --trust-escrow)
  }
};
const GENUINE_ESCROW_CODE = keccak256(receptumEscrowDeployedBytecode);

/**
 * ReceptumEscrow deployments published by the project (see packages/adapter-evm/E2E_RESULTS.md).
 * Matching runtime code alone doesn't prove a contract wasn't deployed with forged storage, so only
 * these — or deployments the caller explicitly trusts — can yield a complete verification.
 */
export const TRUSTED_ESCROWS: Record<string, readonly string[]> = {
  "eip155:5042002": ["0x20d69c6c647559f48a7e6b0a3f922e99a4068f16"],
  "eip155:421614": ["0x1cd7ed69a10d5aafcf2fcb927a431183b3c43862"],
  // Soroban ReceptumEscrow (packages/adapter-stellar/contracts/receptum-escrow/deployment.testnet.json).
  "stellar:testnet": ["CAFAWMTCCIIVMLATUZ5GMBMPQE5JYJVP35SLVJCNIH6HMARFJDICVWGG"],
  // Mainnets: deliberately EMPTY. No ReceptumEscrow has been deployed to a mainnet; escrow
  // contracts go to mainnet only after an independent audit (docs/MAINNET.md §0). Until a
  // deployment is published here, mainnet escrow receipts report an untrusted deployment.
  "eip155:8453": [],
  "eip155:5042": [],
  "eip155:42161": [],
  "stellar:pubnet": [],
};

/** The "not in the registry" result, worded for mainnets that have no published deployment. */
function untrustedDeployment(network: string, what: string): string {
  const published = TRUSTED_ESCROWS[network]?.length ?? 0;
  return networkClass(network) === "mainnet" && published === 0
    ? `untrusted deployment: no ${what} deployment has been published for mainnet ${network} yet (pass --trust-escrow to accept it)`
    : `untrusted deployment: ${what}, but this deployment isn't in the trusted registry (pass --trust-escrow to accept it)`;
}

/** Same Stellar asset, whether written `CODE:ISSUER`, `native` or as its contract id. */
function sameStellarAsset(a: string, b: string, network: string): boolean {
  try {
    return (
      tokenContractId(a, stellarNetwork(network)) === tokenContractId(b, stellarNetwork(network))
    );
  } catch {
    return false;
  }
}

/** The NetworkID the connected rippled reports in `server_info`, if any. */
async function xrplServedNetworkId(client: Client): Promise<number | undefined> {
  const info = await client.request({ command: "server_info" });
  const id = (info.result.info as { network_id?: unknown }).network_id;
  return typeof id === "number" ? id : undefined;
}

async function withXrpl<T>(network: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const url = xrplWss(network);
  if (!url) throw new Unavailable(`no XRPL endpoint configured for ${network}`);
  const client = new Client(url);
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
  const name = `${PAYMENT_CHECK}${network}`;
  const fail = (detail: string): Check => ({ level: 3, name, status: "fail", detail });
  const pending = (detail: string): Check => ({ level: 3, name, status: "pending", detail });
  const pass = (detail: string): Check => ({ level: 3, name, status: "pass", detail });
  const unavailable = (detail: string): Check => ({
    level: 3,
    name,
    status: "unavailable",
    detail,
  });
  const noPayee = () =>
    unavailable("receipt does not name a payee, so the recipient can't be confirmed");
  const payerAddr = accountOn(network, payer);
  const payeeAddr = accountOn(network, payee);
  if (payerAddr === null) return fail(`payment.payer is not an account on ${network}`);
  if (payeeAddr === null) return fail(`payment.payee is not an account on ${network}`);
  try {
    if (rail === "escrow:receptum-evm") {
      const evm = evmClient(network);
      if (!evm) return unavailable(`unsupported network ${network}`);
      let ref: ReturnType<typeof parseEscrowId>;
      try {
        ref = parseEscrowId(reference);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      if (ref.network !== network)
        return fail(`escrow reference is on ${ref.network}, receipt says ${network}`);
      await assertChain(evm.client, network);
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
      if (!trusted) return pending(untrustedDeployment(network, "ReceptumEscrow code"));
      if (!payeeAddr) return noPayee();
      if (statusName === "delivered")
        return pending(
          "delivery committed; funds still held awaiting acceptance or the review window",
        );
      return pass("escrow released to the payee; committed receiptHash and terms match");
    }
    if (rail === SOROBAN_ESCROW_RAIL) {
      if (!STELLAR_IDS.includes(network)) return unavailable(`unsupported network ${network}`);
      let ref: ReturnType<typeof parseSorobanEscrowId>;
      try {
        ref = parseSorobanEscrowId(reference);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      if (ref.network !== network)
        return fail(`escrow reference is on ${ref.network}, receipt says ${network}`);
      const rpc = new SorobanRpcClient({ network: stellarNetwork(network) });
      if ((await rpc.contractWasmHash(ref.contractId)) !== RECEPTUM_SOROBAN_WASM_HASH)
        return fail("referenced contract does not run the published ReceptumEscrow wasm");
      const e = await rpc.readEscrow(ref.contractId, ref.id);
      const acc = signed.receipt.acceptance;
      let token: string | null = null;
      try {
        token = tokenContractId(asset, stellarNetwork(network));
      } catch {
        // reported below
      }
      const problems = [
        e.receiptHash !== signed.receiptHash && "committed receiptHash differs",
        e.amount.toString() !== amount && "amount differs",
        e.token !== token && "token differs from payment.asset",
        payerAddr && e.buyer !== payerAddr && "buyer differs from payment.payer",
        payeeAddr && e.seller !== payeeAddr && "seller differs from payment.payee",
        e.reviewWindowSeconds !== acc.reviewWindowSeconds &&
          "review window differs from acceptance.reviewWindowSeconds",
        acc.mode === "evaluator" &&
          (!e.evaluator || e.evaluator !== accountOn(network, acc.evaluator)) &&
          "evaluator differs from acceptance.evaluator",
        acc.mode !== "evaluator" &&
          e.evaluator &&
          "escrow has an evaluator the receipt doesn't declare",
      ].filter(Boolean);
      if (problems.length) return fail(`escrow ${e.status}: ${problems.join("; ")}`);
      if (e.status !== "released" && e.status !== "delivered")
        return fail(`escrow is ${e.status}, not released`);
      const trusted = [...(TRUSTED_ESCROWS[network] ?? []), ...trustedEscrows].includes(
        ref.contractId,
      );
      if (!trusted) return pending(untrustedDeployment(network, "ReceptumEscrow wasm"));
      if (!payeeAddr) return noPayee();
      if (e.status === "delivered")
        return pending(
          "delivery committed; funds still held awaiting acceptance or the review window",
        );
      return pass("Soroban escrow released to the payee; committed receiptHash and terms match");
    }
    if (rail === STELLAR_ESCROW_RAIL) {
      if (!STELLAR_IDS.includes(network)) return unavailable(`unsupported network ${network}`);
      try {
        if (!CLAIMABLE_REFERENCE.test(reference)) throw new TypeError();
        parseStellarEscrowId(reference);
      } catch {
        return fail(
          `invalid Stellar escrow id: ${reference} (expected the claimable balance id: 00000000 + 64 hex, or its B… strkey)`,
        );
      }
      const state = await new StellarClaimableEscrowRail({
        network: stellarNetwork(network),
      }).getEscrow(reference);
      const acc = signed.receipt.acceptance;
      const window =
        (Date.parse(state.releasableAfter!) - Date.parse(state.refundableAfter)) / 1000;
      const problems = [
        state.receiptHash !== signed.receiptHash &&
          "no delivery anchor for this receipt before the deadline",
        state.amount !== amount && "amount differs",
        !sameStellarAsset(state.asset, asset, network) && "asset differs",
        payerAddr && state.buyer !== payerAddr && "buyer differs from payment.payer",
        payeeAddr && state.seller !== payeeAddr && "seller differs from payment.payee",
        window !== acc.reviewWindowSeconds &&
          "review window differs from acceptance.reviewWindowSeconds",
        acc.mode === "evaluator" && "claimable-balance escrows can't enforce an evaluator",
      ].filter(Boolean);
      if (problems.length) return fail(`escrow ${state.status}: ${problems.join("; ")}`);
      if (!payeeAddr) return noPayee();
      if (state.status === "delivered")
        return pending("delivered; awaiting the buyer window to pass or the buyer's acceptance");
      if (state.status !== "released") return fail(`escrow is ${state.status}`);
      return pass(
        `claimable balance released to the payee (${state.releasedBy}); first delivery anchor ${state.deliveredBy} matches`,
      );
    }
    if (rail.startsWith("x402:") && rail !== "x402:exact")
      return unavailable(`only the x402 "exact" scheme is recognised, not ${rail}`);
    if (rail === "x402:exact" && network.startsWith("xrpl:"))
      return { level: 3, name, ...(await verifyXrplX402Payment(signed.receipt.payment)) };
    if (rail === "x402:exact" && STELLAR_IDS.includes(network)) {
      // SPEC §7.3 (Stellar): a successful transaction whose Stellar Asset Contract `transfer`
      // moves exactly `amount` of `asset` to the payee (from the payer, when stated).
      if (!/^[0-9a-f]{64}$/.test(reference))
        return fail("payment.reference is not a Stellar transaction hash (64 lower-case hex)");
      try {
        tokenContractId(asset, stellarNetwork(network));
      } catch {
        return fail("payment.asset is not a Stellar asset (CODE:ISSUER, native or a C… contract)");
      }
      if (!payeeAddr) return noPayee();
      const r = await findSacTransfer(
        reference,
        { asset, amount, to: payeeAddr, ...(payerAddr ? { from: payerAddr } : {}) },
        { network: stellarNetwork(network) },
      );
      return r.ok
        ? pass(`${amount} base units paid to ${payeeAddr} in ledger ${r.ledger}`)
        : fail(r.reason);
    }
    if (rail === "x402:exact" && network.startsWith("eip155:")) {
      // SPEC §7.3 (EVM): mined and successful, with an ERC-20 Transfer(payer → payee, amount)
      // emitted by the token contract payment.asset.
      if (!EVM_ADDRESS.test(asset))
        return fail("payment.asset must be the token contract address for x402:exact on eip155");
      if (!EVM_TX.test(reference)) return fail("payment.reference is not an EVM transaction hash");
      if (payeeAddr !== undefined && !EVM_ADDRESS.test(payeeAddr))
        return fail(`payment.payee is not an EVM account on ${network}`);
      if (payerAddr !== undefined && !EVM_ADDRESS.test(payerAddr))
        return fail(`payment.payer is not an EVM account on ${network}`);
      const evm = evmClient(network);
      if (!evm) return unavailable(`unsupported network ${network}`);
      if (!payeeAddr) return noPayee();
      await assertChain(evm.client, network);
      const tx = await evm.client.getTransactionReceipt({ hash: reference as Hex });
      if (tx.status !== "success") return fail("settlement transaction reverted");
      const paid = tx.logs.some((log) =>
        erc20TransferMatches(log, { asset, amount, payee: payeeAddr, payer: payerAddr }),
      );
      return paid
        ? pass(`${amount} base units paid to ${payeeAddr} in block ${tx.blockNumber}`)
        : fail("no transfer of that amount to the payee in the settlement transaction");
    }
    if (rail === "escrow:xrpl") {
      if (!xrplWss(network)) return unavailable(`unsupported network ${network}`);
      try {
        parseXrplEscrowId(reference);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      const r = await withXrpl(network, async (client) => {
        // SPEC §7.3: the server must serve payment.network, as for x402 (otherwise unavailable).
        const served = await xrplServedNetworkId(client);
        const want = Number(network.slice("xrpl:".length));
        if (served !== undefined && served !== want)
          return {
            status: "unavailable" as const,
            detail: `could not be checked: the XRPL server serves NetworkID ${served}, not ${want}`,
          };
        return verifyXrplEscrowPayment(signed, (id) =>
          new XrplEscrowRail({ client, network }).getEscrow(id),
        );
      });
      return { level: 3, name, ...r };
    }
    return unavailable(`no settlement check for rail ${rail} on ${network}`);
  } catch (err) {
    return fromError(3, name, err);
  }
}

/**
 * Splits an anchor reference `<caip2>:<tx>` (SPEC §7.1), e.g. `eip155:5042002:0x…`,
 * `xrpl:1:ABC…`, `stellar:testnet:abc…`. Returns null when it is malformed.
 */
export function parseAnchorRef(anchorRef: string): { network: string; reference: string } | null {
  if (typeof anchorRef !== "string") return null;
  const i = anchorRef.lastIndexOf(":");
  const network = anchorRef.slice(0, i);
  const reference = anchorRef.slice(i + 1);
  if (i <= 0 || !reference || !isCaip2(network)) return null;
  return { network, reference };
}

/** Level 3 for one anchor reference (SPEC §7.1). */
async function verifyAnchor(signed: SignedReceipt, anchorRef: string): Promise<Check> {
  const parsed = parseAnchorRef(anchorRef);
  const name = `Anchor on ${parsed?.network ?? anchorRef}`;
  const fail = (detail: string): Check => ({ level: 3, name, status: "fail", detail });
  const pass = (detail: string): Check => ({ level: 3, name, status: "pass", detail });
  const unavailable = (detail: string): Check => ({
    level: 3,
    name,
    status: "unavailable",
    detail,
  });
  if (!parsed) return fail("anchor reference must be <caip2>:<transaction>");
  const { network, reference } = parsed;
  const hash = signed.receiptHash;
  try {
    if (network.startsWith("eip155:")) {
      // anchor:evm — a mined, successful, zero-value tx whose calldata is exactly
      // utf8("receptum/1") ‖ receiptHash (32 raw bytes).
      if (!EVM_TX.test(reference)) return fail("anchor transaction hash is malformed");
      const evm = evmClient(network);
      if (!evm) return unavailable(`unsupported network ${network}`);
      await assertChain(evm.client, network);
      const tx = await evm.client.getTransaction({ hash: reference as Hex });
      const mined = await evm.client.getTransactionReceipt({ hash: reference as Hex });
      if (mined.status !== "success") return fail("anchor transaction reverted");
      if (tx.input.toLowerCase() !== anchorCalldata(hash).toLowerCase())
        return fail("anchor calldata is not utf8('receptum/1') ‖ receiptHash");
      if (tx.value !== 0n) return fail("anchor transaction is not zero-value");
      const txChain = (tx as { chainId?: number }).chainId;
      if (txChain !== undefined && txChain !== evm.net.chain.id)
        return fail("anchor transaction chainId does not match the anchor network");
      return pass(
        `receiptHash anchored in ${reference} (block ${mined.blockNumber}, from ${tx.from})`,
      );
    }
    if (xrplWss(network)) {
      // anchor:xrpl — a validated tesSUCCESS tx whose first receptum/1 memo carries receiptHash.
      if (!/^[0-9A-Fa-f]{64}$/.test(reference)) return fail("anchor transaction hash is malformed");
      return await withXrpl(network, async (client) => {
        const served = await xrplServedNetworkId(client);
        const want = Number(network.slice("xrpl:".length));
        if (served !== undefined && served !== want)
          return unavailable(`the XRPL server serves NetworkID ${served}, not ${want}`);
        let result: {
          validated?: boolean;
          meta?: unknown;
          tx_json?: { Memos?: Parameters<typeof parseReceiptMemos>[0] };
          ledger_index?: number;
        };
        try {
          ({ result } = (await client.request({ command: "tx", transaction: reference })) as {
            result: typeof result;
          });
        } catch (err) {
          // Servers may lack history: an unknown transaction is undecided (as for x402, §7.1).
          if ((err as { data?: { error?: string } })?.data?.error === "txnNotFound")
            return unavailable("anchor transaction not found on this server (it may lack history)");
          throw err;
        }
        if (result.validated !== true)
          return unavailable("anchor transaction is not in a validated ledger yet");
        if ((result.meta as { TransactionResult?: string })?.TransactionResult !== "tesSUCCESS")
          return fail("anchor transaction did not succeed");
        return parseReceiptMemos(result.tx_json?.Memos).receiptHash === hash
          ? pass(`memo anchored in validated ledger ${result.ledger_index ?? "?"}`)
          : fail("no receptum/1 memo for this receiptHash in that transaction");
      });
    }
    if (STELLAR_IDS.includes(network)) {
      // anchor:stellar — a successful tx with MEMO_HASH = receiptHash.
      if (!/^[0-9a-f]{64}$/.test(reference)) return fail("anchor transaction hash is malformed");
      const found = await new StellarAnchor({ network: stellarNetwork(network) }).find(hash, {
        reference,
      });
      return found
        ? pass(`MEMO_HASH anchored ${found.anchoredAt}`)
        : fail("no successful MEMO_HASH transaction for this receiptHash at that reference");
    }
    return unavailable(`unsupported anchor network ${network}`);
  } catch (err) {
    return fromError(3, name, err);
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
 * against the account's current master/regular key (validated ledger only); when they can't be
 * read the result is `unavailable` unless no binding could pass even with them.
 */
export async function verifyBinding(
  signed: SignedReceipt,
  options: { offline?: boolean; allowUnbound?: boolean } = {},
): Promise<Check> {
  const name = "Seller controls payee";
  const payee = signed.receipt.payment.payee;
  if (!payee) return { level: 2.5, name, status: "skipped", detail: "receipt names no payee" };
  const bindings = signed.bindings as unknown;
  if (bindings === undefined || bindings === null || (Array.isArray(bindings) && !bindings.length))
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
  let lookupError: string | undefined;
  const xrplNet = /^(xrpl:[0-9]+):/.exec(payee)?.[1];
  if (!options.offline && xrplNet && xrplWss(xrplNet)) {
    const address = payee.slice(xrplNet.length + 1);
    try {
      verifiers.unshift(
        await withXrpl(xrplNet, (client) => xrplOnlineBindingVerifier(client, address)),
      );
      mode = "online, current account keys";
    } catch (err) {
      lookupError = `could not load XRPL account keys: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const res = checkPayeeBinding(signed, { verifiers });
  if (lookupError !== undefined) {
    // Offline rules only: a pass, or a key that may be the account's regular key, is undecided.
    if (res.ok)
      return {
        level: 2.5,
        name,
        status: "unavailable",
        detail: `${lookupError}; offline the binding verifies (${res.detail})`,
      };
    if (/not the master key/.test(res.reason))
      return {
        level: 2.5,
        name,
        status: "unavailable",
        detail: `${lookupError}; a binding is signed by a key that only an online check can judge`,
      };
    return { level: 2.5, name, status: "fail", detail: `${res.reason} (${lookupError})` };
  }
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
  /** Anchor references to check, `<caip2>:<tx>` (SPEC §7.1). */
  anchors?: string[];
  /** Skip all network checks. */
  offline?: boolean;
  /** Extra ReceptumEscrow deployments (EVM addresses or Soroban contract ids) to trust, in addition to TRUSTED_ESCROWS. */
  trustedEscrows?: string[];
  /**
   * Accept receipts without an account binding (legacy receipts): L2.5 is then `skipped`.
   * Invalid bindings still fail.
   */
  allowUnbound?: boolean;
}

/**
 * The SPEC §6 verdict for a set of checks. NOT VERIFIED when any check failed; VERIFIED when
 * none is pending or unavailable, L1 and L2 passed, L2.5 passed or was skipped, the payment
 * passed on its rail and `receiptHash` is committed on-chain (by the escrow rail itself, or by a
 * passing anchor); otherwise PARTIALLY VERIFIED, with each missing piece listed.
 */
export function verdictOf(
  signed: SignedReceipt,
  checks: readonly Check[],
): { verdict: Verdict; missing: string[] } {
  if (checks.some((c) => c.status === "fail")) return { verdict: "NOT VERIFIED", missing: [] };
  const missing: string[] = [];
  const file = checks.find((c) => c.level === 1);
  if (file?.status !== "pass")
    missing.push(
      `L1: ${file?.detail ?? "no delivered file given"} — the output was not compared with outputSha256`,
    );
  const sig = checks.find((c) => c.level === 2);
  if (sig?.status !== "pass") missing.push("L2: the seller signature was not verified");
  const binding = checks.find((c) => c.level === 2.5);
  if (binding?.status === "pending")
    missing.push(
      "L2.5: nothing proves the seller controls the payee (pass --allow-unbound for legacy receipts)",
    );
  else if (binding && binding.status !== "pass" && binding.status !== "skipped")
    missing.push(`L2.5: ${binding.status} — ${binding.detail}`);
  const payment = checks.find((c) => c.level === 3 && c.name.startsWith(PAYMENT_CHECK));
  if (payment?.status !== "pass")
    missing.push(
      `L3: the payment was not confirmed on its rail (${payment ? `${payment.status} — ${payment.detail}` : "not checked"})`,
    );
  const anchors = checks.filter(
    (c) => c.level === 3 && !c.name.startsWith(PAYMENT_CHECK) && c.name !== COMMIT_CHECK,
  );
  for (const a of anchors)
    if (a.status !== "pass") missing.push(`L3 ${a.name}: ${a.status} — ${a.detail}`);
  const rail = signed?.receipt?.payment?.rail;
  if (!COMMITTING_RAILS.includes(rail) && !anchors.some((a) => a.status === "pass"))
    missing.push(
      `L3: receiptHash is not committed on-chain — ${rail} does not commit it, so a mined anchor is required (--anchor <caip2>:<tx>, or the input wrapper's "anchor")`,
    );
  return { verdict: missing.length ? "PARTIALLY VERIFIED" : "VERIFIED", missing };
}

/** Runs every applicable check and the SPEC §6 verdict. */
export async function verify(
  signed: SignedReceipt,
  options: VerifyOptions = {},
): Promise<VerifyReport> {
  const checks = await verifyOffline(signed, options.file);
  const signatureOk = checks.some((c) => c.level === 2 && c.status === "pass");
  checks.push(
    signatureOk
      ? await verifyBinding(signed, {
          ...(options.offline ? { offline: true } : {}),
          ...(options.allowUnbound ? { allowUnbound: true } : {}),
        })
      : {
          level: 2.5,
          name: "Seller controls payee",
          status: "skipped",
          detail: "receipt signature is invalid",
        },
  );
  const anchors = [...new Set(options.anchors ?? [])];
  const network = signed?.receipt?.payment?.network;
  const skip = (name: string, detail: string): Check => ({
    level: 3,
    name,
    status: "skipped",
    detail,
  });
  if (!signatureOk) {
    // An unauthenticated receipt never reaches the network.
    checks.push(skip(`${PAYMENT_CHECK}${network}`, "receipt not authenticated"));
  } else if (options.offline) {
    checks.push(skip(`${PAYMENT_CHECK}${network}`, "offline: settlement not checked"));
    for (const a of anchors)
      checks.push(skip(`Anchor on ${parseAnchorRef(a)?.network ?? a}`, "offline: not checked"));
  } else {
    checks.push(await verifyPayment(signed, options.trustedEscrows));
    for (const a of anchors) checks.push(await verifyAnchor(signed, a));
  }
  if (signatureOk && !anchors.length && !COMMITTING_RAILS.includes(signed.receipt.payment.rail))
    checks.push(skip(COMMIT_CHECK, "no anchor given; the receiptHash commitment was not checked"));
  const { verdict, missing } = verdictOf(signed, checks);
  return {
    verdict,
    ok: verdict !== "NOT VERIFIED",
    complete: verdict === "VERIFIED",
    missing,
    receiptHash: signed?.receiptHash,
    seller: signed?.receipt?.seller?.id,
    ...(typeof network === "string" ? { network } : {}),
    networkClass: networkClass(typeof network === "string" ? network : undefined),
    checks,
  };
}

/**
 * One-line header that tells mainnet receipts apart from testnet ones — printed first by the
 * CLI. A testnet receipt is evidence about test tokens only.
 */
export function networkLabel(report: Pick<VerifyReport, "network" | "networkClass">): string {
  const n = report.network ?? "unknown network";
  if (report.networkClass === "mainnet") return `=== MAINNET receipt (${n}) — real funds ===`;
  if (report.networkClass === "testnet")
    return `=== TESTNET receipt (${n}) — test tokens, no real value ===`;
  return `=== receipt on an unrecognised network (${n}) — neither a known mainnet nor testnet ===`;
}

/** A receipt file: a bare signed receipt, or a wrapper `{ signedReceipt, anchor?, … }`. */
export interface ReceiptInput {
  signed: SignedReceipt;
  /** Anchor references carried by the wrapper (`anchor`: one string or an array of strings). */
  anchors: string[];
}

/**
 * Parses a receipt file (SPEC §6.1): strict I-JSON (duplicate member names, lone surrogates,
 * out-of-range numbers and invalid UTF-8 are rejected), then either a bare signed receipt or a
 * wrapper object with a `signedReceipt` member. The wrapper's `anchor` (a `<caip2>:<tx>` string
 * or an array of them) is returned so it can be checked; every other wrapper member is
 * informational and never trusted. Throws `JsonInputError` / `TypeError` on bad input.
 */
export function parseReceiptInput(bytes: Uint8Array): ReceiptInput {
  const doc = parseStrictJsonBytes(bytes);
  if (typeof doc !== "object" || doc === null || Array.isArray(doc))
    throw new JsonInputError("a receipt file must hold a JSON object");
  const o = doc as Record<string, unknown>;
  if (!Object.hasOwn(o, "signedReceipt"))
    return { signed: o as unknown as SignedReceipt, anchors: [] };
  const a = o.anchor;
  const anchors =
    a === undefined
      ? []
      : typeof a === "string"
        ? [a]
        : Array.isArray(a) && a.every((x) => typeof x === "string")
          ? (a as string[])
          : null;
  if (anchors === null)
    throw new TypeError('wrapper "anchor" must be a <caip2>:<tx> string or an array of them');
  return { signed: o.signedReceipt as SignedReceipt, anchors };
}
