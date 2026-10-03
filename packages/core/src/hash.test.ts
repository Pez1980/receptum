import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSha256Hex, sha256File, sha256Hex } from "./hash.js";

describe("hashing", () => {
  it("matches the known SHA-256 of 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes files identically to in-memory data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workreceipt-"));
    const file = join(dir, "clip.bin");
    await writeFile(file, "abc");
    expect(await sha256File(file)).toBe(sha256Hex("abc"));
  });

  it("only accepts lowercase 64-char hex", () => {
    expect(isSha256Hex(sha256Hex("x"))).toBe(true);
    expect(isSha256Hex(sha256Hex("x").toUpperCase())).toBe(false);
  });
});
