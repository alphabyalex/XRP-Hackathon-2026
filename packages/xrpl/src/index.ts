// Real implementation of the packages/xrpl contract (A9.1).
// Owner: Tharun.
// Every write function returns TxResult = { hash, result, validated, explorerUrl }.

export { setupNetwork } from "./setup.js";
export { getBalances, getHolders } from "./balances.js";
export {
  listShareOffers,
  buyShares,
  sellShares,
  listContractOffers,
  buyContracts,
} from "./dex.js";
export { redeemContracts } from "./contracts.js";
export { payForInference } from "./inference.js";
export { payDividends } from "./dividends.js";
export { openLoan, repayLoan, settleLoan } from "./loans.js";
export { publishOracle } from "./oracle.js";
export { subscribe } from "./subscribe.js";

// Export typed errors (B1)
export {
  InsufficientFunds,
  NoLiquidity,
  TrustlineMissing,
  LedgerRejected,
} from "./errors.js";

// Export SHOULD / COULD extensions (B5, B6)
export {
  issueCredential,
  acceptCredential,
  createPermissionedDomain,
  setupPermissionedShares,
  MS_KYC_CREDENTIAL_TYPE,
} from "./permissioned.js";

export {
  createPaymentChannel,
  signChannelClaim,
  verifyChannelClaim,
  claimPaymentChannel,
} from "./paychan.js";

// Export utilities
export { checkFeatures } from "./features.js";
export { getClient, disconnectClient } from "./client.js";
export { getAccountWallet, getAccountAddress, loadAccountsJson } from "./wallets.js";

// XLS-65 vaults and XLS-66 loan brokers (devnet lending)
export {
  BROKER_ACCOUNT,
  BROKER_DEFAULTS,
  createVault,
  depositToVault,
  withdrawFromVault,
  getVault,
  getVaultShares,
  setupLoanBroker,
  depositCover,
  getLoanBroker,
  createRound,
  pruneRounds,
  loadLendingState,
  currentRound,
  findRound,
  roundPhase,
} from "./lending.js";
export { ensureLendingRounds } from "./setup.js";
