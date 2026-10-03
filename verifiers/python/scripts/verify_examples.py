"""Re-verifies every published testnet receipt against live chains with the Python verifier —
the same cases and expected verdicts as scripts/verify-examples.mjs (needs network; not in CI).

    python verifiers/python/scripts/verify_examples.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "verifiers" / "python" / "src"))

from receptum_verify import extract_signed_receipt, loads_strict, verify  # noqa: E402


def read(path: str) -> bytes:
    return (ROOT / path).read_bytes()


def doc(path: str):
    return loads_strict(read(path))


def wrapper(d) -> tuple[dict, list[str]]:
    return extract_signed_receipt(d)


def cases() -> list[tuple[str, tuple[dict, list[str]], bytes | None, str]]:
    """(label, (signed receipt, anchors), delivered bytes, expected verdict) per published case —
    the same list, in the same order, as scripts/verify-examples.mjs."""
    soroban = doc("packages/adapter-stellar/e2e-soroban-results.json")["flows"]
    claimable = doc("packages/adapter-stellar/e2e-claimable-results.json")["flows"]
    arc = doc("packages/adapter-evm/e2e-results.json")["flows"]
    mcp = doc("packages/mcp/e2e-results.json")
    return [
        ("x402 · Base Sepolia, anchored on Arc", wrapper(doc("examples/x402-base-sepolia.json")),
         read("examples/x402-base-sepolia-output.svg"), "VERIFIED"),
        ("x402 · Stellar testnet, anchored on Arc", wrapper(doc("examples/x402-stellar-testnet.json")),
         read("examples/x402-stellar-testnet-output.svg"), "VERIFIED"),
        ("x402 · XRPL testnet, memo anchor", wrapper(doc("examples/x402-xrpl-testnet.json")),
         read("examples/x402-xrpl-testnet-output.svg"), "VERIFIED"),
        ("x402 · XRPL testnet, issued token (RCPT), memo anchor",
         wrapper(doc("examples/x402-xrpl-token-testnet.json")),
         read("examples/x402-xrpl-token-testnet-output.svg"), "VERIFIED"),
        ("x402-paid MCP tool · Base Sepolia, anchored on Arc", (mcp["receipt"], [mcp["anchor"]]),
         read("examples/deliverables/mcp-base-sepolia-tool-result.json"), "VERIFIED"),
        ("ReceptumEscrow · Arc · buyer accepts", wrapper(doc("examples/arc-testnet-escrow-a.json")),
         read("examples/deliverables/arc-testnet-escrow-a.txt"), "VERIFIED"),
        ("ReceptumEscrow · Arc · auto-release", (arc[1]["signedReceipt"], []),
         read("examples/deliverables/arc-testnet-escrow-b.txt"), "VERIFIED"),
        ("ReceptumEscrow · Arc · standalone anchor demo (no escrow behind it)",
         (arc[3]["signedReceipt"], [f"eip155:5042002:{arc[3]['txs']['anchor']}"]), None, "NOT VERIFIED"),
        ("XRPL Escrow · crypto-condition release", wrapper(doc("examples/xrpl-testnet-escrow-a.json")),
         read("examples/deliverables/xrpl-testnet-escrow-a.txt"), "VERIFIED"),
        ("XRPL TokenEscrow · issued token (RCT, 3-character code), crypto-condition release",
         wrapper(doc("examples/xrpl-testnet-escrow-c.json")),
         read("examples/deliverables/xrpl-testnet-escrow-c.txt"), "VERIFIED"),
        ("XRPL Escrow · evaluator finishes from its own account",
         wrapper(doc("examples/xrpl-testnet-escrow-evaluator.json")),
         read("examples/deliverables/xrpl-testnet-escrow-evaluator.txt"), "VERIFIED"),
        ("XRPL TokenEscrow · issued token (RCPT), buyer accepts",
         wrapper(doc("examples/xrpl-testnet-escrow-token.json")),
         read("examples/deliverables/xrpl-testnet-escrow-token.txt"), "VERIFIED"),
        ("Soroban escrow · buyer accepts", (soroban["A"]["signedReceipt"], []),
         soroban["A"]["deliverable"].encode(), "VERIFIED"),
        ("Soroban escrow · auto-release", (soroban["B"]["signedReceipt"], []),
         soroban["B"]["deliverable"].encode(), "VERIFIED"),
        ("Soroban escrow · evaluator rejected (refunded)", (soroban["D"]["signedReceipt"], []),
         soroban["D"]["deliverable"].encode(), "NOT VERIFIED"),
        ("Soroban escrow · seller refunded voluntarily", (soroban["E"]["signedReceipt"], []),
         soroban["E"]["deliverable"].encode(), "NOT VERIFIED"),
        ("Stellar claimable balance · auto-release", (claimable["A"]["signedReceipt"], []),
         read("examples/deliverables/stellar-claimable-a.txt"), "VERIFIED"),
        ("Stellar claimable balance · buyer accepts", (claimable["B"]["signedReceipt"], []),
         read("examples/deliverables/stellar-claimable-b.txt"), "VERIFIED"),
        ("Stellar claimable balance · buyer rejected (refunded)", (claimable["D"]["signedReceipt"], []),
         read("examples/deliverables/stellar-claimable-d.txt"), "NOT VERIFIED"),
        ("Tampered x402 receipt (amount edited)", wrapper(doc("examples/x402-base-sepolia-tampered.json")),
         read("examples/x402-base-sepolia-output.svg"), "NOT VERIFIED"),
    ]


def main() -> int:
    bad = 0
    for label, (signed, anchors), file_bytes, want in cases():
        report = verify(signed, file_bytes, anchor=anchors)
        ok = report.status == want
        bad += not ok
        # Same line format as scripts/verify-examples.mjs, so both outputs can be diffed.
        line = f"{'ok  ' if ok else 'FAIL'} {report.status:<18} {label}"
        if not ok:
            failed = [f"{k}: {v.status} — {v.detail}" for k, v in report.levels.items() if v.status != "pass"]
            line += f" (expected {want}; {'; '.join(report.missing or failed)})"
        print(line)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
