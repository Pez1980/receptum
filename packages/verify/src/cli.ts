#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parseReceiptInput, verify, type ReceiptInput } from "./index.js";

const usage =
  "usage: receptum-verify <receipt.json> [delivered-file] [--anchor <caip2>:<tx>]... [--trust-escrow <address|contract-id>]... [--allow-unbound] [--offline] [--json]";

let values: Record<string, string[] | boolean | undefined>;
let positionals: string[];
try {
  ({ values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      anchor: { type: "string", multiple: true },
      "trust-escrow": { type: "string", multiple: true },
      offline: { type: "boolean" },
      "allow-unbound": { type: "boolean" },
      json: { type: "boolean" },
    },
  }));
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}\n${usage}`);
  process.exit(2);
}

const [receiptPath, filePath] = positionals;
if (!receiptPath) {
  console.error(usage);
  process.exit(2);
}

// Exit 2 = usage or input error: unreadable, or not I-JSON (SPEC §6.1: duplicate member names,
// lone surrogates, out-of-range numbers and invalid UTF-8 are rejected, never "last one wins").
let input: ReceiptInput;
try {
  input = parseReceiptInput(await readFile(receiptPath));
  if (filePath) await readFile(filePath);
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

const anchors = [...input.anchors, ...((values.anchor as string[] | undefined) ?? [])];
const report = await verify(input.signed, {
  ...(filePath ? { file: filePath } : {}),
  ...(anchors.length ? { anchors } : {}),
  ...(values.offline ? { offline: true } : {}),
  ...(values["trust-escrow"] ? { trustedEscrows: values["trust-escrow"] as string[] } : {}),
  ...(values["allow-unbound"] ? { allowUnbound: true } : {}),
});

if (values.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const mark = {
    pass: "PASS",
    fail: "FAIL",
    pending: "WAIT",
    skipped: "SKIP",
    unavailable: "N/A ",
  } as const;
  console.log(`receipt ${report.receiptHash}\nseller  ${report.seller}\n`);
  for (const c of report.checks)
    console.log(`[${mark[c.status]}] L${c.level} ${c.name} — ${c.detail}`);
  console.log(`\n${report.verdict}`);
  for (const m of report.missing) console.log(`  missing: ${m}`);
}
process.exit(report.verdict === "VERIFIED" ? 0 : report.verdict === "NOT VERIFIED" ? 1 : 3);
