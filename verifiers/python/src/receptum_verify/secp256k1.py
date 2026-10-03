"""Minimal secp256k1 for verification only: public-key recovery (EIP-191),
point decoding and ECDSA verification. Pure Python, variable time — it only
ever handles public data, never private keys."""

from __future__ import annotations

__all__ = ["N", "Secp256k1Error", "decode_point", "encode_uncompressed", "recover", "verify"]

P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (
    0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)

Point = tuple[int, int] | None  # None is the point at infinity


class Secp256k1Error(ValueError):
    pass


# Jacobian coordinates (X, Y, Z) with x = X/Z^2, y = Y/Z^3; Z == 0 is infinity.
def _jdouble(p: tuple[int, int, int]) -> tuple[int, int, int]:
    x, y, z = p
    if z == 0 or y == 0:
        return (0, 1, 0)
    ysq = y * y % P
    s = 4 * x * ysq % P
    m = 3 * x * x % P
    nx = (m * m - 2 * s) % P
    ny = (m * (s - nx) - 8 * ysq * ysq) % P
    nz = 2 * y * z % P
    return (nx, ny, nz)


def _jadd(p: tuple[int, int, int], q: tuple[int, int, int]) -> tuple[int, int, int]:
    if p[2] == 0:
        return q
    if q[2] == 0:
        return p
    x1, y1, z1 = p
    x2, y2, z2 = q
    z1s, z2s = z1 * z1 % P, z2 * z2 % P
    u1, u2 = x1 * z2s % P, x2 * z1s % P
    s1, s2 = y1 * z2s * z2 % P, y2 * z1s * z1 % P
    if u1 == u2:
        return _jdouble(p) if s1 == s2 else (0, 1, 0)
    h = (u2 - u1) % P
    r = (s2 - s1) % P
    h2 = h * h % P
    h3 = h * h2 % P
    u1h2 = u1 * h2 % P
    nx = (r * r - h3 - 2 * u1h2) % P
    ny = (r * (u1h2 - nx) - s1 * h3) % P
    nz = h * z1 * z2 % P
    return (nx, ny, nz)


def _to_affine(p: tuple[int, int, int]) -> Point:
    x, y, z = p
    if z == 0:
        return None
    zi = pow(z, -1, P)
    zi2 = zi * zi % P
    return (x * zi2 % P, y * zi2 * zi % P)


def _mul_add(a: int, pa: Point, b: int, pb: Point) -> Point:
    """a*pa + b*pb (Shamir's trick)."""
    ja = (pa[0], pa[1], 1) if pa else (0, 1, 0)
    jb = (pb[0], pb[1], 1) if pb else (0, 1, 0)
    jab = _jadd(ja, jb)
    acc = (0, 1, 0)
    for i in range(max(a.bit_length(), b.bit_length()) - 1, -1, -1):
        acc = _jdouble(acc)
        bits = ((a >> i) & 1, (b >> i) & 1)
        if bits == (1, 1):
            acc = _jadd(acc, jab)
        elif bits == (1, 0):
            acc = _jadd(acc, ja)
        elif bits == (0, 1):
            acc = _jadd(acc, jb)
    return _to_affine(acc)


def _lift_x(x: int, odd: bool) -> tuple[int, int]:
    if not 0 <= x < P:
        raise Secp256k1Error("x is not a field element")
    y2 = (pow(x, 3, P) + 7) % P
    y = pow(y2, (P + 1) // 4, P)
    if y * y % P != y2:
        raise Secp256k1Error("x is not on the curve")
    if (y & 1) != odd:
        y = P - y
    return (x, y)


def decode_point(data: bytes) -> tuple[int, int]:
    """SEC1 compressed (02/03 ‖ x) or uncompressed (04 ‖ x ‖ y) point."""
    if len(data) == 33 and data[0] in (2, 3):
        return _lift_x(int.from_bytes(data[1:], "big"), data[0] == 3)
    if len(data) == 65 and data[0] == 4:
        x, y = int.from_bytes(data[1:33], "big"), int.from_bytes(data[33:], "big")
        if x >= P or y >= P or (y * y - x * x * x - 7) % P:
            raise Secp256k1Error("point is not on the curve")
        return (x, y)
    raise Secp256k1Error("not a SEC1 secp256k1 public key")


def encode_uncompressed(pt: tuple[int, int]) -> bytes:
    return b"\x04" + pt[0].to_bytes(32, "big") + pt[1].to_bytes(32, "big")


def recover(digest: bytes, r: int, s: int, recid: int) -> tuple[int, int]:
    """Recover the public key Q with ECDSA(digest) = (r, s): Q = r⁻¹(sR − eG).

    ``recid`` bit 0 is the parity of R.y; bit 1 (R.x = r + n) is not accepted —
    it is astronomically unlikely and EIP-191 v ∈ {27, 28} cannot express it."""
    if not (1 <= r < N and 1 <= s < N):
        raise Secp256k1Error("r or s out of range")
    if recid not in (0, 1):
        raise Secp256k1Error("unsupported recovery id")
    big_r = _lift_x(r, bool(recid & 1))
    e = int.from_bytes(digest, "big") % N
    rinv = pow(r, -1, N)
    q = _mul_add(s * rinv % N, big_r, (-e * rinv) % N, G)
    if q is None:
        raise Secp256k1Error("recovered the point at infinity")
    return q


def verify(digest: bytes, r: int, s: int, pub: tuple[int, int]) -> bool:
    if not (1 <= r < N and 1 <= s < N):
        return False
    e = int.from_bytes(digest, "big") % N
    w = pow(s, -1, N)
    pt = _mul_add(e * w % N, G, r * w % N, pub)
    return pt is not None and pt[0] % N == r
