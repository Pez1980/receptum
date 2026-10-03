"""receptum-verify CLI.

Exit codes: 0 VERIFIED, 1 NOT VERIFIED, 2 usage/input error, 3 PARTIALLY VERIFIED.
"""

from __future__ import annotations

import argparse
import json
import sys

from .jcs import JCSError, loads_strict
from .networks import network_label
from .verify import NOT_VERIFIED, VERIFIED, InputError, extract_signed_receipt, verify

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
        action="append",
        default=[],
        metavar="CAIP2:TX",
        help="anchor transaction, e.g. eip155:5042002:0x… (repeatable; checked in addition to "
        "the wrapper's `anchor`)",
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
        "--horizon",
        action="append",
        default=[],
        metavar="CAIP2=URL",
        help="override/add a Horizon endpoint for a Stellar network (repeatable)",
    )
    p.add_argument(
        "--trust-escrow",
        action="append",
        default=[],
        metavar="ADDRESS|CONTRACT",
        help="also trust this ReceptumEscrow deployment (EVM address or Soroban contract id; "
        "repeatable)",
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
        signed, wrapper_anchors = extract_signed_receipt(doc)
    except (OSError, JCSError, InputError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    endpoints: dict[str, dict[str, str]] = {"rpc": {}, "horizon": {}}
    for flag in endpoints:
        for item in getattr(args, flag):
            caip2, sep, url = item.partition("=")
            if not sep:
                print(f"error: --{flag} expects CAIP2=URL, got {item!r}", file=sys.stderr)
                return 2
            endpoints[flag][caip2] = url

    report = verify(
        signed,
        file_bytes,
        anchor=wrapper_anchors + args.anchor,
        offline=args.offline,
        rpcs=endpoints["rpc"],
        horizons=endpoints["horizon"],
        allow_unbound=args.allow_unbound,
        trusted_escrows=args.trust_escrow,
    )

    if args.json:
        print(json.dumps(report.to_dict(), indent=2))
    else:
        # Header: mainnet and testnet receipts are labelled distinctly, before anything else.
        print(network_label(report.network))
        print(report.status)
        if report.receipt_hash:
            print(f"  receiptHash  {report.receipt_hash}")
        if report.seller:
            print(f"  seller       {report.seller}")
        print(f"  network      {report.network or '?'} ({report.network_class})")
        labels = {
            "file": "L1 file",
            "signature": "L2 signature",
            "binding": "L2.5 binding",
            "settlement": "L3 settlement",
            "anchor": "L3 anchor",
        }
        for key, check in report.levels.items():
            label = labels.get(key, f"L3 {key}")
            print(f"  {label:<14} {check.status.upper():<11} {check.detail}")
        for item in report.missing:
            print(f"  missing: {item}")
    return _EXIT.get(report.status, 3)
