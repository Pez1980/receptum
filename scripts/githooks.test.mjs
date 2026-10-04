// .githooks/pre-push (review round 4, finding 5): a failed `pnpm check` must show why, not just
// "failed". Runs the hook with a stub `pnpm` on PATH; nothing is pushed.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const HOOK = new URL("../.githooks/pre-push", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "receptum-hook-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(stub) {
  writeFileSync(join(dir, "pnpm"), `#!/bin/sh\n${stub}\n`);
  chmodSync(join(dir, "pnpm"), 0o755);
  return spawnSync("sh", [HOOK], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PRE_PUSH_TAIL: "3" },
  });
}

describe("pre-push hook", () => {
  it("prints the tail of a failed pnpm check and refuses the push", () => {
    const r = run('for i in 1 2 3 4 5; do echo "line $i"; done; echo "FAIL boom" >&2; exit 1');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("pnpm check failed");
    expect(r.stderr).toContain("FAIL boom");
    expect(r.stderr).toContain("line 5");
    expect(r.stderr).not.toContain("line 2"); // only the tail
  });

  it("is silent and allows the push when the check passes", () => {
    const r = run('echo "all good"; exit 0');
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });
});
