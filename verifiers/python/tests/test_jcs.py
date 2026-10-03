import struct

import pytest

from receptum_verify.jcs import JCSError, canonicalize, loads_strict, serialize_number


def from_hex(h: str) -> float:
    return struct.unpack(">d", bytes.fromhex(h))[0]


# RFC 8785 Appendix B.
APPENDIX_B = [
    ("0000000000000000", "0"),
    ("8000000000000000", "0"),
    ("0000000000000001", "5e-324"),
    ("8000000000000001", "-5e-324"),
    ("7fefffffffffffff", "1.7976931348623157e+308"),
    ("ffefffffffffffff", "-1.7976931348623157e+308"),
    ("4340000000000000", "9007199254740992"),
    ("c340000000000000", "-9007199254740992"),
    ("4430000000000000", "295147905179352830000"),
    ("44b52d02c7e14af5", "9.999999999999997e+22"),
    ("44b52d02c7e14af6", "1e+23"),
    ("44b52d02c7e14af7", "1.0000000000000001e+23"),
    ("444b1ae4d6e2ef4e", "999999999999999700000"),
    ("444b1ae4d6e2ef4f", "999999999999999900000"),
    ("444b1ae4d6e2ef50", "1e+21"),
    ("3eb0c6f7a0b5ed8c", "9.999999999999997e-7"),
    ("3eb0c6f7a0b5ed8d", "0.000001"),
    ("41b3de4355555553", "333333333.3333332"),
    ("41b3de4355555554", "333333333.33333325"),
    ("41b3de4355555555", "333333333.3333333"),
    ("41b3de4355555556", "333333333.3333334"),
    ("41b3de4355555557", "333333333.33333343"),
    ("becbf647612f3696", "-0.0000033333333333333333"),
    ("43143ff3c1cb0959", "1424953923781206.2"),
]


@pytest.mark.parametrize("bits,expected", APPENDIX_B)
def test_rfc8785_appendix_b_numbers(bits, expected):
    assert serialize_number(from_hex(bits)) == expected


@pytest.mark.parametrize("bits", ["7fffffffffffffff", "7ff0000000000000", "fff0000000000000"])
def test_rfc8785_appendix_b_rejects_nan_and_infinity(bits):
    with pytest.raises(JCSError):
        serialize_number(from_hex(bits))


def test_more_numbers():
    assert serialize_number(1) == "1"
    assert serialize_number(-1) == "-1"
    assert serialize_number(123.0) == "123"
    assert serialize_number(0.1) == "0.1"
    assert serialize_number(1e21) == "1e+21"
    assert serialize_number(1e-7) == "1e-7"
    assert serialize_number(1.5e-7) == "1.5e-7"
    assert serialize_number(2**53 + 2) == "9007199254740994"
    assert serialize_number(10**21) == "1e+21"
    with pytest.raises(JCSError):
        serialize_number(10**400)
    with pytest.raises(JCSError):
        serialize_number(True)


def test_rfc8785_section_3_2_2_example():
    src = (
        '{\n  "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],\n'
        '  "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",\n'
        '  "literals": [null, true, false]\n}'
    )
    expected = (
        '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],'
        '"string":"\u20ac$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}'
    )
    assert canonicalize(loads_strict(src)) == expected.encode("utf-8")


def test_rfc8785_section_3_2_3_utf16_sorting():
    src = (
        '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh",'
        '"1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control",'
        '"\\u00f6":"Latin Small Letter O With Diaeresis"}'
    )
    out = canonicalize(loads_strict(src)).decode("utf-8")
    assert out == (
        '{"\\r":"Carriage Return","1":"One","\u0080":"Control",'
        '"\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign",'
        '"\U0001f600":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}'
    )


def test_rfc8785_section_3_2_4_utf8_bytes():
    out = canonicalize(loads_strict('{"\\u20ac":"\\u20ac"}'))
    assert out == b'{"\xe2\x82\xac":"\xe2\x82\xac"}'


def test_utf16_vs_codepoint_ordering():
    # U+FB33 sorts after U+1F600 by code point but before it by UTF-16 code unit.
    assert canonicalize({"\U0001f600": 1, "\ufb33": 2}) == '{"\U0001f600":1,"\ufb33":2}'.encode()


def test_control_character_escapes():
    s = "".join(chr(i) for i in range(0x20)) + "\x7f"
    out = canonicalize(s).decode()
    assert out.startswith('"\\u0000\\u0001')
    assert "\\b\\t\\n\\u000b\\f\\r" in out
    assert out.endswith('\\u001f\x7f"')


@pytest.mark.parametrize(
    "bad",
    [
        '{"a":1,"a":2}',
        '"\\ud800"',
        '{"\\udc00":1}',
        '"\\ude00\\ud83d"',
        "NaN",
        "[Infinity]",
        "1e400",
        "[1,]",
        "{'a':1}",
    ],
)
def test_loads_strict_rejects(bad):
    with pytest.raises(JCSError):
        loads_strict(bad)


def test_loads_strict_rejects_bad_bytes():
    with pytest.raises(JCSError):
        loads_strict(b"\xef\xbb\xbf{}")
    with pytest.raises(JCSError):
        loads_strict(b'"\xff"')


def test_canonicalize_rejects_lone_surrogate_and_bad_types():
    with pytest.raises(JCSError):
        canonicalize("\ud800")
    with pytest.raises(JCSError):
        canonicalize({1: "x"})
    with pytest.raises(JCSError):
        canonicalize(float("nan"))
    with pytest.raises(JCSError):
        canonicalize({"a": object()})


def test_surrogate_pair_is_accepted():
    assert canonicalize(loads_strict('"\\ud83d\\ude00"')) == '"\U0001f600"'.encode()
