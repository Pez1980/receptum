# Proposal: content-binding fields for the x402 offer-and-receipt extension

**Status:** submitted upstream on 4 Oct 2026 as [review comment on x402-foundation/x402#3186](https://github.com/x402-foundation/x402/pull/3186#issuecomment-5973093815). That PR (following issue [#2833](https://github.com/x402-foundation/x402/issues/2833)) already adds a signed `responseHash` to a v2 receipt, so instead of a duplicate proposal we asked for the three pieces it lacks: a defined hash input for MCP tool results, an optional request/input hash, and the settled `amount` ([#3006](https://github.com/x402-foundation/x402/issues/3006)). · **Target:** `specs/extensions/extension-offer-and-receipt.md` · **Author:** Receptum (Apache-2.0)

## Summary

The offer-and-receipt extension lets a resource server sign a receipt confirming that "payment was received and service was delivered" (§5). The receipt payload (§5.2) records `network`, `resourceUrl`, `payer`, `issuedAt` and optionally `transaction` — but not **which output** was delivered. Two different responses to the same paid request produce indistinguishable receipts.

We propose three **optional** receipt payload fields that bind the receipt to the exact bytes delivered, without publishing them:

| Field          | Type                              | Description                                                                                      |
| -------------- | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `outputSha256` | string (64 lower-case hex)        | SHA-256 of the response body exactly as delivered                                                |
| `inputSha256`  | string[] (64 lower-case hex each) | SHA-256 of each input the server consumed (e.g. request body, uploaded file)                     |
| `amount`       | string (integer, atomic units)    | Amount settled, when known — the receipt otherwise requires an on-chain lookup to know the price |

All three are optional, privacy-preserving (hashes only), and backwards compatible: existing verifiers ignore unknown fields once the extension's forward-compatibility rules allow it, and new verifiers can check `SHA-256(body) == outputSha256` offline.

## Motivation

- **Disputes between machines.** Agents buying long-running jobs (renders, transcription, research) need to show _which_ deliverable a payment bought. Today the only evidence is each party's logs.
- **Regeneration and substitution.** Generative services can legitimately or illegitimately return different outputs for the same request. A content hash in the signed receipt settles which one was delivered.
- **Composability.** A content-bound receipt can anchor escrow release (ERC-8183 deliverable hashes, XRPL/Stellar memos) and reputation systems with a single value.

## Specification text (proposed §5.2 additions)

> `outputSha256` — OPTIONAL. Lower-case hex SHA-256 of the HTTP response body bytes as sent to the client (after content encoding is removed). For MCP tool results, SHA-256 of the RFC 8785 (JCS) serialization of `{ content, structuredContent?, isError? }`.
>
> `inputSha256` — OPTIONAL. Array of lower-case hex SHA-256 hashes of the inputs the server consumed to produce the output, in a server-defined order.
>
> `amount` — OPTIONAL. Decimal string of the settled amount in the asset's atomic units.
>
> Clients that receive `outputSha256` SHOULD reject the response if `SHA-256(body) != outputSha256`. Servers MUST NOT include raw inputs or outputs in the receipt.

For `format = "eip712"`, add `bytes32 outputSha256`, `bytes32[] inputSha256` and `string amount` to the `Receipt` type when present (absent fields are omitted from the type, consistent with the extension's existing optional `transaction`).

## Reference implementation

Receptum implements this binding today as a standalone, chain-neutral receipt (RRF v1) that travels next to x402 settlements:

- Spec and test vectors: [`docs/SPEC.md`](../SPEC.md), [`spec/vectors/rrf-v1.json`](../../spec/vectors/rrf-v1.json)
- Server/client: [`@receptum/server`](../../packages/server), [`@receptum/client`](../../packages/client); MCP: [`@receptum/mcp`](../../packages/mcp)
- Live testnet evidence: [`examples/E2E_RESULTS.md`](../../examples/E2E_RESULTS.md) — a 0.25 USDC x402 `exact` payment on Base Sepolia whose receipt binds the delivered SVG by hash; the client refuses the result if the hash doesn't match.

If the fields are adopted upstream, Receptum will emit them inside the x402 receipt as well, so plain x402 clients get content binding without any Receptum dependency.

## Open questions for maintainers

1. Should `outputSha256` cover the encoded or decoded body? (We propose decoded.)
2. Is `amount` better placed in the settlement response than in the signed receipt?
3. Would maintainers prefer a separate `delivery` sub-object to keep §5.2 minimal?
