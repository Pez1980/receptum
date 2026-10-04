// An agent that buys one render through x402 and only accepts it with a valid Receptum receipt.
//
//   RENDER_URL=http://localhost:4021/render node buyer.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createReceptumFetch } from "@receptum/client";
import { evmBindingVerifier } from "@receptum/adapter-evm";

const url = process.env.RENDER_URL ?? "http://localhost:4021/render";
const dir = process.env.RECEPTUM_WALLETS_DIR ?? join(homedir(), ".config/receptum/wallets");
const wallets = JSON.parse(readFileSync(join(dir, "evm-testnet.json"), "utf8"));
const expectedSeller = readFileSync(join(dir, "seller-did.txt"), "utf8").trim();

const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    {
      network: "eip155:84532",
      client: new ExactEvmScheme(privateKeyToAccount(wallets.buyer.privateKey)),
    },
  ],
});
const buy = createReceptumFetch({
  paidFetch,
  networks: ["eip155:84532"], // what paidFetch is registered to pay on (required)
  allowedSellers: [expectedSeller],
  // The buyer's own expectations — never taken from the response.
  expected: {
    network: "eip155:84532",
    maxAmount: "250000",
    payer: privateKeyToAccount(wallets.buyer.privateKey).address,
  },
  // Only accept receipts whose seller proves it controls the account that was paid.
  requireBinding: true,
  bindingVerifiers: [evmBindingVerifier],
});

const result = await buy(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt: "Know what you paid for." }),
});

console.log("paid and verified:", result.check);
console.log("settlement:", result.settlement?.transaction, "on", result.settlement?.network);
console.log("receiptHash:", result.receipt.receiptHash);
console.log("anchor:", result.response.headers.get("Receptum-Anchor"));
if (process.env.OUT) {
  writeFileSync(
    process.env.OUT,
    JSON.stringify(
      {
        settlement: result.settlement,
        anchor: result.response.headers.get("Receptum-Anchor"),
        signedReceipt: result.receipt,
        check: result.check,
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(process.env.OUT.replace(/\.json$/, ".svg"), result.body);
}
