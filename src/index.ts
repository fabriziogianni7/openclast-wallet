/**
 * @fabriziogianni7/openclaw-evm-wallet-integration
 * Native custodial wallet: OS keychain, configurable EVM chains, notify-and-approve flow.
 */

export {
  formatPendingTxNotification,
  resolveWalletChains,
  resolveDefaultChainId,
  resolveWalletChainConfig,
  resolveWalletChainConfigForBalance,
  getBlockExplorerTxUrl,
  getBlockExplorerAddressUrl,
  resolveWalletConfig,
  getWalletsDir,
  createWalletServiceFromConfig,
  initWalletOnStartup,
  createKeychainAdapter,
  createWalletService,
  createRpcClient,
  createPendingStore,
  createStateStore,
  createAuditLog,
  privateKeyToAddress,
  buildAndSignTx,
  SEPOLIA_CHAIN_ID,
} from "./wallet/index.js";

export type {
  WalletService,
  WalletServiceConfig,
  PendingTx,
  WalletMeta,
  WalletState,
  WalletConfig,
  WalletsLimits,
  WalletIntegrationConfig,
  AuditEntry,
  AuditLogFilter,
} from "./wallet/index.js";

export { resolveStateDir } from "./wallet/index.js";
