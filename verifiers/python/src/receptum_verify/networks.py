"""Network classes and the trusted ReceptumEscrow deployment registry.

Mirrors ``@receptum/core`` (networks) and ``@receptum/verify`` (TRUSTED_ESCROWS). Verification is
read-only, so mainnet receipts need no opt-in here — but they are always labelled as mainnet,
and a mainnet escrow can only count once its deployment has been published below.
"""

from __future__ import annotations

__all__ = [
    "MAINNET_NETWORKS",
    "TESTNET_NETWORKS",
    "TRUSTED_ESCROWS",
    "network_class",
    "network_label",
    "untrusted_deployment",
]

TESTNET_NETWORKS = frozenset(
    {
        "eip155:84532",
        "eip155:5042002",
        "eip155:421614",
        "eip155:31337",
        "eip155:1337",
        "xrpl:1",
        "stellar:testnet",
    }
)
MAINNET_NETWORKS = frozenset(
    {"eip155:8453", "eip155:5042", "eip155:42161", "xrpl:0", "stellar:pubnet"}
)

# ReceptumEscrow deployments published by the project. Mainnet entries are deliberately EMPTY:
# nothing has been deployed to a mainnet, and escrow contracts go there only after an independent
# audit (docs/MAINNET.md §0). Until a deployment is published, mainnet escrow receipts report an
# untrusted deployment.
TRUSTED_ESCROWS: dict[str, tuple[str, ...]] = {
    "eip155:5042002": ("0x20d69c6c647559f48a7e6b0a3f922e99a4068f16",),
    "eip155:421614": ("0x1cd7ed69a10d5aafcf2fcb927a431183b3c43862",),
    "stellar:testnet": ("CAFAWMTCCIIVMLATUZ5GMBMPQE5JYJVP35SLVJCNIH6HMARFJDICVWGG",),
    "eip155:8453": (),
    "eip155:5042": (),
    "eip155:42161": (),
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


def untrusted_deployment(network: str, reference: str) -> str | None:
    """Detail for an escrow reference whose deployment isn't in TRUSTED_ESCROWS, else None."""
    trusted = TRUSTED_ESCROWS.get(network, ())
    if any(t.lower() in reference.lower() for t in trusted):
        return None
    if network_class(network) == "mainnet" and not trusted:
        return (
            "untrusted deployment: no ReceptumEscrow deployment has been published for "
            f"mainnet {network} yet"
        )
    return "untrusted deployment: this ReceptumEscrow deployment isn't in the trusted registry"
