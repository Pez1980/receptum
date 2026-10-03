import copy
import json
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
VECTORS = REPO / "spec" / "vectors" / "rrf-v1.json"
EXAMPLES = REPO / "examples"


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture
def vectors():
    return load_json(VECTORS)


@pytest.fixture
def signed_vector(vectors):
    v = vectors["vectors"][0]
    return copy.deepcopy({"receipt": v["receipt"], "receiptHash": v["receiptHash"], "proof": v["proof"]})


@pytest.fixture
def live_doc():
    return load_json(EXAMPLES / "x402-base-sepolia.json")


@pytest.fixture
def live_output():
    return (EXAMPLES / "x402-base-sepolia-output.svg").read_bytes()


PACKAGES = REPO / "packages"
RH = "1acd382d98b7f628092b8c2f05107bb738bfd9c68077c11ae21e62cc747736a4"


def escrow_signed(payment, acceptance=None, receipt_hash=RH):
    """The parts of a signed receipt a level-3 rail check reads (signature is checked elsewhere)."""
    return {
        "receipt": {
            "payment": dict(payment),
            "acceptance": dict(acceptance or {"mode": "buyer", "reviewWindowSeconds": 600}),
        },
        "receiptHash": receipt_hash,
    }


def bare(caip10):
    """The bare account of a CAIP-10 id (rail checks receive payer/payee already split)."""
    return caip10.rpartition(":")[2] if caip10 else None
