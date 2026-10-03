"""Network classes and the trusted ReceptumEscrow deployment registry.

Mirrors ``@receptum/core`` (networks) and ``@receptum/verify`` (TRUSTED_ESCROWS). This is the one
registry: the EVM and Soroban escrow checks read it. Verification is read-only, so mainnet receipts
need no opt-in here — but they are always labelled as mainnet, and a genuine mainnet escrow stays
``pending`` (untrusted deployment) until its deployment has been published below.
"""

from __future__ import annotations

__all__ = [
    "MAINNET_NETWORKS",
    "TESTNET_NETWORKS",
    "TRUSTED_ESCROWS",
    "is_trusted_deployment",
    "network_class",
    "network_label",
    "untrusted_deployment",
]

TESTNET_NETWORKS = frozenset(
    {"eip155:84532", "eip155:5042002", "eip155:31337", "eip155:1337", "xrpl:1", "stellar:testnet"}
)
MAINNET_NETWORKS = frozenset({"eip155:8453", "eip155:5042", "xrpl:0", "stellar:pubnet"})

# ReceptumEscrow deployments published by the project. Mainnet entries are deliberately EMPTY:
# nothing has been deployed to a mainnet, and escrow contracts go there only after an independent
# audit (docs/MAINNET.md §0). Until a deployment is published, mainnet escrow receipts report an
# untrusted deployment.
TRUSTED_ESCROWS: dict[str, tuple[str, ...]] = {
    "eip155:5042002": ("0x20d69c6c647559f48a7e6b0a3f922e99a4068f16",),
    "stellar:testnet": ("CAFAWMTCCIIVMLATUZ5GMBMPQE5JYJVP35SLVJCNIH6HMARFJDICVWGG",),
    "eip155:8453": (),
    "eip155:5042": (),
    "stellar:pubnet": (),
}


def network_class(caip2: str | None) -> str:
    """``mainnet``, ``testnet`` or ``unknown``."""
    if caip2 in TESTNET_NETWORKS:
        return "testnet"
    if caip2 in MAINNET_NETWORKS:
        return "mainnet"
    return "unknown"


def network_label(caip2: str | None) -> str:
    """The CLI header line that tells mainnet receipts apart from testnet ones."""
    name = caip2 or "unknown network"
    cls = network_class(caip2)
    if cls == "mainnet":
        return f"=== MAINNET receipt ({name}) — real funds ==="
    if cls == "testnet":
        return f"=== TESTNET receipt ({name}) — test tokens, no real value ==="
    return f"=== receipt on an unrecognised network ({name}) — neither a known mainnet nor testnet ==="


def is_trusted_deployment(
    network: str, deployment: str, extra: "list[str] | tuple[str, ...]" = ()
) -> bool:
    """Is ``deployment`` (an EVM address, compared case-insensitively, or a Soroban contract id,
    compared exactly) published in TRUSTED_ESCROWS for ``network``, or explicitly trusted by the
    caller (``--trust-escrow``)? Trust never carries over from one network to another."""
    def same(a: str, b: str) -> bool:
        if a.startswith("0x") and b.startswith("0x"):
            return a.lower() == b.lower()
        return a == b

    return any(same(t, deployment) for t in (*TRUSTED_ESCROWS.get(network, ()), *extra))


def untrusted_deployment(network: str, what: str) -> str:
    """The "not in the registry" detail (``pending``), worded for mainnets that have no published
    deployment yet. ``what`` is "ReceptumEscrow code" (EVM) or "ReceptumEscrow wasm" (Soroban).
    Same wording as the TypeScript verifier."""
    if network_class(network) == "mainnet" and not TRUSTED_ESCROWS.get(network):
        return (
            f"untrusted deployment: no {what} deployment has been published for mainnet "
            f"{network} yet (pass --trust-escrow to accept it)"
        )
    return (
        f"untrusted deployment: {what}, but this deployment isn't in the trusted registry "
        "(pass --trust-escrow to accept it)"
    )
