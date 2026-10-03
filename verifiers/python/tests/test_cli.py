import json

from receptum_verify.cli import main

from conftest import EXAMPLES


def test_cli_offline_json(capsys):
    code = main(
        [
            str(EXAMPLES / "x402-base-sepolia.json"),
            str(EXAMPLES / "x402-base-sepolia-output.svg"),
            "--offline",
            "--json",
        ]
    )
    out = json.loads(capsys.readouterr().out)
    assert code == 3
    assert out["status"] == "PARTIALLY VERIFIED"
    assert out["levels"]["file"]["status"] == "pass"
    assert out["levels"]["signature"]["status"] == "pass"


def test_cli_bare_signed_receipt(tmp_path, live_doc, capsys):
    path = tmp_path / "signed.json"
    path.write_text(json.dumps(live_doc["signedReceipt"]))
    assert main([str(path), "--offline"]) == 3
    assert capsys.readouterr().out.startswith("PARTIALLY VERIFIED")


def test_cli_tampered(capsys):
    code = main([str(EXAMPLES / "x402-base-sepolia-tampered.json"), "--offline"])
    assert code == 1
    assert capsys.readouterr().out.startswith("NOT VERIFIED")


def test_cli_bad_input(tmp_path, capsys):
    path = tmp_path / "dup.json"
    path.write_text('{"receipt":1,"receipt":2}')
    assert main([str(path), "--offline"]) == 2
    assert main([str(tmp_path / "missing.json")]) == 2
