// @receptum/adapter-xrpl — XRPL native Escrow and memo-anchored receipts. See README.md.
export { XRPL_ANCHOR_RAIL, XrplAnchor, type XrplAnchorOptions } from "./anchor.js";
export {
  conditionFromPreimage,
  fulfillmentFromPreimage,
  fulfillmentMatches,
  newEscrowSecret,
  preimageFromFulfillment,
  type EscrowSecret,
} from "./condition.js";
export {
  caip10,
  currencyCode,
  currencyId,
  currencySymbol,
  ESCROW_MEMO_TYPE,
  formatEscrowId,
  fromXrplAmount,
  parseEscrowId,
  parseReceiptMemos,
  parseXrplAsset,
  RECEIPT_MEMO_TYPE,
  receiptMemos,
  toXrplAmount,
  xrplAmountId,
  type XrplAmount,
  type XrplAssetId,
} from "./encoding.js";
export {
  XRPL_ESCROW_CAPABILITIES,
  XRPL_ESCROW_RAIL,
  XrplEscrowRail,
  type CreateEscrowParams,
  type XrplEscrowRailOptions,
  type XrplEscrowState,
} from "./escrow.js";
export {
  assertNetwork,
  assertTestnet,
  xrplNetworkId,
  XRPL_ENDPOINTS,
  XRPL_MAINNET,
  XRPL_MAINNET_NETWORK_ID,
  XRPL_TESTNET,
  XRPL_TESTNET_NETWORK_ID,
  type NetworkGuardOptions,
  XrplHistoryIncompleteError,
  XrplTxError,
} from "./ledger.js";
export {
  xrplAccountSigner,
  xrplBindingVerifier,
  xrplOnlineBindingVerifier,
  xrplSecp256k1SignatureError,
} from "./binding.js";
