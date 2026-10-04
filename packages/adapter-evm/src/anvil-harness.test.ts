// The local-anvil test harness (review round 4, finding 5): a free port per run instead of a fixed
// one, child start-up failures detected instead of polled into a timeout, and an awaited shutdown.
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freePort, startAnvil } from "./anvil.test-util.js";

const ANVIL = [join(homedir(), ".foundry/bin/anvil"), "anvil"].find((bin) => {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});

describe("anvil test harness", () => {
  it("allocates a free localhost port", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    const srv = createServer();
    await new Promise<void>((ok, ko) => srv.once("error", ko).listen(port, "127.0.0.1", ok));
    await new Promise((ok) => srv.close(ok));
  });

  it("reports a child that dies at start-up at once, with its output", async () => {
    const t = Date.now();
    // `node --port …` exits immediately with "bad option".
    await expect(startAnvil(process.execPath, { attempts: 1 })).rejects.toThrow(
      /exited \(code 9\) before it was ready.*bad option/s,
    );
    expect(Date.now() - t).toBeLessThan(5_000);
  });

  it("reports a binary that can't be spawned", async () => {
    await expect(startAnvil("/nonexistent/anvil", { attempts: 1 })).rejects.toThrow(/ENOENT/);
  });

  describe.skipIf(!ANVIL)("with Foundry's anvil", () => {
    it("starts on a free port, answers JSON-RPC and shuts down when stopped", async () => {
      const a = await startAnvil(ANVIL!);
      const res = await fetch(a.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      expect(((await res.json()) as { result?: string }).result).toBe("0x7a69");
      await a.stop();
      expect(a.exited()).toBe(true);
      await a.stop(); // idempotent
    });

    // A squatter on the port that drops every connection (so close() never waits on one).
    const squat = () => createServer((sock) => sock.destroy());

    it("detects a port that is already taken instead of timing out", async () => {
      const srv = squat();
      const port = await freePort();
      await new Promise<void>((ok) => srv.listen(port, "127.0.0.1", ok));
      try {
        await expect(startAnvil(ANVIL!, { port, attempts: 1 })).rejects.toThrow(
          /before it was ready/,
        );
      } finally {
        await new Promise((ok) => srv.close(ok));
      }
    });

    it("retries on a new port when the first one is lost", async () => {
      const srv = squat();
      const port = await freePort();
      await new Promise<void>((ok) => srv.listen(port, "127.0.0.1", ok));
      try {
        const a = await startAnvil(ANVIL!, { port, attempts: 2 });
        expect(a.port).not.toBe(port);
        await a.stop();
      } finally {
        await new Promise((ok) => srv.close(ok));
      }
    });
  });
});
