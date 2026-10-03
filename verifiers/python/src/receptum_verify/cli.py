"""receptum-verify CLI.

Exit codes: 0 VERIFIED, 1 NOT VERIFIED, 2 usage/input error, 3 PARTIALLY VERIFIED.
"""

from __future__ import annotations

import argparse
import json
import sys

from .jcs import JCSError, loads_strict
from .verify import NOT_VERIFIED, VERIFIED, extract_signed_receipt, verify

_EXIT = {VERIFIED: 0, NOT_VERIFIED: 1}


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m receptum_verify",
        description=(
            "Verify a Receptum (RRF v1) receipt: file, signature, account binding, "
            "settlement, anchor."
        ),
    )
    p.add_argument("receipt", help="signed receipt JSON, or an object with `signedReceipt`")
    p.add_argument("file", nargs="?", help="delivered file to compare with outputSha256")
    p.add_argument(
        "--anchor",
        metavar="CAIP2:TX",
        help="EVM anchor transaction, e.g. eip155:5042002:0x… (defaults to the wrapper's `anchor`)",
    )
    p.add_argument("--offline", action="store_true", help="skip level 3 and the online XRPL key check (no network)")
    p.add_argument(
        "--rpc",
        action="append",
        default=[],
        metavar="CAIP2=URL",
        help="override/add a JSON-RPC endpoint (repeatable)",
    )
    p.add_argument(
        "--allow-unbound",
        action="store_true",
        help="accept a receipt without any account binding (legacy receipts); invalid bindings still fail",
    )
    p.add_argument("--json", action="store_true", help="machine-readable output")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        with open(args.receipt, "rb") as fh:
            doc = loads_strict(fh.read())
        file_bytes = None
        if args.file:
            with open(args.file, "rb") as fh:
                file_bytes = fh.read()
    except (OSError, JCSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    rpcs = {}
    for item in args.rpc:
        caip2, sep, url = item.partition("=")
        if not sep:
            print(f"error: --rpc expects CAIP2=URL, got {item!r}", file=sys.stderr)
            return 2
        rpcs[caip2] = url

    signed, wrapper_anchor = extract_signed_receipt(doc)
    anchor = args.anchor or wrapper_anchor
    report = verify(
        signed,
        file_bytes,
        anchor=anchor,
        offline=args.offline,
        rpcs=rpcs,
        allow_unbound=args.allow_unbound,
    )

    if args.json:
        print(json.dumps(report.to_dict(), indent=2))
    else:
        print(report.status)
        if report.receipt_hash:
            print(f"  receiptHash  {report.receipt_hash}")
        if report.seller:
            print(f"  seller       {report.seller}")
        labels = {
            "file": "L1 file",
            "signature": "L2 signature",
            "binding": "L2.5 binding",
            "settlement": "L3 settlement",
            "anchor": "L3 anchor",
        }
        for key, check in report.levels.items():
            print(f"  {labels[key]:<14} {check.status.upper():<11} {check.detail}")
    return _EXIT.get(report.status, 3)
