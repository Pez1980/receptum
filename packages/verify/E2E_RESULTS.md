# Cross-chain verification (Oct 3, 2026)

`receptum-verify` independently checked receipts produced by every adapter's live testnet run:

| Receipt                                                                    | Checks                                                                          | Result                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------- |
| x402 render, Base Sepolia (`examples/x402-base-sepolia.json`) + Arc anchor | file hash · seller signature · USDC transfer in settlement tx · anchor calldata | VERIFIED                   |
| Arc escrow, flow A (`packages/adapter-evm/e2e-results.json`)               | signature · escrow released with matching committed receiptHash and amount      | VERIFIED                   |
| XRPL escrow, flow A (`packages/adapter-xrpl/E2E_RESULTS.md`)               | signature · receipt memo on deliver tx `03477D9B…A549C7`                        | VERIFIED                   |
| Stellar escrow, auto-release (`packages/adapter-stellar/E2E_RESULTS.md`)   | signature · MEMO_HASH on deliver tx `26a35e0f…cf5af`                            | VERIFIED                   |
| Arc receipt with the amount edited                                         | signature / receiptHash                                                         | NOT VERIFIED (as expected) |

```sh
node packages/verify/dist/cli.js examples/x402-base-sepolia.json examples/x402-base-sepolia-output.svg \
  --anchor eip155:5042002:0x178192fa86acc85fb2b33189708703a96125feb5bef6c6817f8faedeefaa6103
```
