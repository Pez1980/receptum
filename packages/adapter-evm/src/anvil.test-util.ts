// Test helper: runs a local anvil on a free port. Not part of the package build.
import { spawn } from "node:child_process";
import { createServer } from "node:net";

/** A TCP port on 127.0.0.1 that was free a moment ago (the OS picks it). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() =>
        typeof addr === "object" && addr ? resolve(addr.port) : reject(new Error("no port")),
      );
    });
  });
}

export interface Anvil {
  port: number;
  url: string;
  /** True once the child process has exited. */
  exited(): boolean;
  /** Stops the child and resolves once it has exited (SIGKILL after 5 s). Idempotent. */
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Use this port for the first attempt (default: a free one). */
  port?: number;
  /** Start attempts; each retry uses a new free port (the port can be lost to a race). */
  attempts?: number;
  /** How long to wait for JSON-RPC to answer. */
  timeoutMs?: number;
  args?: string[];
}

async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(1_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function startOnce(bin: string, port: number, timeoutMs: number, args: string[]): Promise<Anvil> {
  const child = spawn(bin, ["--port", String(port), "--host", "127.0.0.1", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const keep = (d: Buffer) => {
    output = (output + d.toString()).slice(-2_000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  let exitCode: number | null | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code) => {
      exitCode = code;
      resolve();
    });
    child.once("error", () => resolve());
  });
  const url = `http://127.0.0.1:${port}`;
  const handle: Anvil = {
    port,
    url,
    exited: () => exitCode !== undefined || child.exitCode !== null || child.signalCode !== null,
    async stop() {
      if (handle.exited()) return;
      child.kill("SIGTERM");
      const t = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(t);
    },
  };
  return new Promise<Anvil>((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      if (err) void handle.stop().then(() => reject(err));
      else resolve(handle);
    };
    child.once("error", (err) => finish(new Error(`could not start ${bin}: ${err.message}`)));
    child.once("exit", (code, signal) =>
      finish(
        new Error(
          `${bin} exited (code ${code ?? signal}) before it was ready: ${output.trim().slice(-500)}`,
        ),
      ),
    );
    const deadline = Date.now() + timeoutMs;
    const poll = async () => {
      while (!done && Date.now() < deadline) {
        if (await answers(url)) return finish();
        await new Promise((r) => setTimeout(r, 100));
      }
      finish(new Error(`${bin} did not answer on ${url} within ${timeoutMs} ms`));
    };
    void poll();
  });
}

/** Starts anvil (or `bin`) on a free port; rejects as soon as the child fails to start. */
export async function startAnvil(bin: string, options: StartOptions = {}): Promise<Anvil> {
  const attempts = options.attempts ?? 3;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    const port = i === 0 && options.port !== undefined ? options.port : await freePort();
    try {
      return await startOnce(bin, port, options.timeoutMs ?? 15_000, options.args ?? ["--silent"]);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}
