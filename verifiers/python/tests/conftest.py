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
