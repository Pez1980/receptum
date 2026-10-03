#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { SignedReceipt } from "@receptum/core";
import { verify } from "./index.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    anchor: { type: "string", multiple: true },
    "trust-escrow": { type: "string", multiple: true },
    offline: { type: "boolean" },
    json: { type: "boolean" },
  },
});

const [receiptPath, filePath] = positionals;
if (!receiptPath) {
  console.error(
    "usage: receptum-verify <receipt.json> [delivered-file] [--anchor <caip2>:<tx>]... [--trust-escrow <address|contract-id>]... [--offline] [--json]",
  );
  process.exit(2);
}

const parsed = JSON.parse(await readFile(receiptPath, "utf8")) as SignedReceipt & {
  signedReceipt?: SignedReceipt;
};
const signed = parsed.signedReceipt ?? parsed;
const report = await verify(signed, {
  ...(filePath ? { file: filePath } : {}),
  ...(values.anchor ? { anchors: values.anchor } : {}),
  ...(values.offline ? { offline: true } : {}),
  ...(values["trust-escrow"] ? { trustedEscrows: values["trust-escrow"] } : {}),
});

if (values.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const mark = { pass: "PASS", fail: "FAIL", pending: "WAIT", skipped: "SKIP" } as const;
  console.log(`receipt ${report.receiptHash}\nseller  ${report.seller}\n`);
  for (const c of report.checks)
    console.log(`[${mark[c.status]}] L${c.level} ${c.name} — ${c.detail}`);
  console.log(
    `\n${!report.ok ? "NOT VERIFIED" : report.complete ? "VERIFIED" : "PARTIALLY VERIFIED — the payment itself was not confirmed on its rail"}`,
  );
}
process.exit(!report.ok ? 1 : report.complete ? 0 : 3);
