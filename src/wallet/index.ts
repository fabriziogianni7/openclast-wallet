/**
 * Native custodial wallet: OS keychain, configurable EVM chains, notify-and-approve flow.
 */

import { resolveStateDir } from "./config-adapter.js";
import type { WalletIntegrationConfig } from "./config-adapter.js";
import { createWalletService } from "./service.js";
import type { PendingTx, WalletConfig } from "./types.js";
import { SEPOLIA_CHAIN_ID } from "./types.js";

export function formatPendingTxNotification(pending: PendingTx): string {
  return [
    "Wallet send approval required.",
    `Tx ID: ${pending.txId}`,
    `From: ${pending.from}`,
    `To: ${pending.to}`,
    `Value (wei): ${pending.valueWei}`,
    `Chain ID: ${pending.chainId}`,
    "",
    `To approve: moltbot wallet approve --tx-id ${pending.txId}`,
  ].join("\n");
}

export type { WalletService, WalletServiceConfig } from "./service.js";
export type { PendingTx, WalletMeta, WalletState, WalletConfig, WalletsLimits } from "./types.js";
export { createKeychainAdapter } from "./keychain.js";
export { createWalletService } from "./service.js";
export { createRpcClient } from "./rpc.js";
export { createPendingStore } from "./pending-store.js";
export { createStateStore } from "./state-store.js";
export { createAuditLog } from "./audit.js";
export type { AuditEntry, AuditLogFilter } from "./audit.js";
export { privateKeyToAddress, buildAndSignTx } from "./tx-builder.js";
export { SEPOLIA_CHAIN_ID } from "./types.js";
export type { WalletIntegrationConfig } from "./config-adapter.js";
export { resolveStateDir } from "./config-adapter.js";

const WELL_KNOWN_CHAIN_IDS: Record<string, number> = {
  sepolia: SEPOLIA_CHAIN_ID,
  [String(SEPOLIA_CHAIN_ID)]: SEPOLIA_CHAIN_ID,
};

function parseChainIdFromKey(key: string): number | null {
  const lower = key.toLowerCase().trim();
  if (WELL_KNOWN_CHAIN_IDS[lower] != null) return WELL_KNOWN_CHAIN_IDS[lower];
  const n = Number.parseInt(key, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return null;
}

/**
 * Build a map of chainId -> WalletConfig from config.
 */
export function resolveWalletChains(cfg: WalletIntegrationConfig): Record<number, WalletConfig> {
  const chains = cfg.wallets?.chains;
  if (!chains || typeof chains !== "object") return {};
  const out: Record<number, WalletConfig> = {};
  for (const key of Object.keys(chains)) {
    const chainId = parseChainIdFromKey(key);
    if (chainId == null) continue;
    const entry = chains[key];
    if (!entry || typeof entry !== "object") continue;
    const rpcUrl =
      typeof entry.rpcUrl === "string" && entry.rpcUrl.trim()
        ? entry.rpcUrl.trim()
        : chainId === SEPOLIA_CHAIN_ID
          ? "https://rpc.sepolia.org"
          : undefined;
    if (rpcUrl) {
      const blockExplorerUrl =
        typeof entry.blockExplorerUrl === "string" && entry.blockExplorerUrl.trim()
          ? entry.blockExplorerUrl.trim().replace(/\/$/, "")
          : undefined;
      out[chainId] = { chainId, rpcUrl, ...(blockExplorerUrl ? { blockExplorerUrl } : {}) };
    }
  }
  return out;
}

/**
 * Default chain ID when multiple are configured.
 * Picks the first non-testnet chain, otherwise the first configured chain.
 * Sepolia is only used if it's the *only* configured chain.
 */
export function resolveDefaultChainId(cfg: WalletIntegrationConfig): number {
  const map = resolveWalletChains(cfg);
  const ids = Object.keys(map).map(Number).filter((n) => Number.isFinite(n));
  if (ids.length === 0) return SEPOLIA_CHAIN_ID;
  // Prefer a non-testnet chain as default
  const nonTestnet = ids.find((id) => id !== SEPOLIA_CHAIN_ID);
  return nonTestnet ?? ids[0];
}

/**
 * Get config for a specific chain, or null if not configured.
 */
export function resolveWalletChainConfig(
  cfg: WalletIntegrationConfig,
  chainId: number,
): WalletConfig | null {
  const map = resolveWalletChains(cfg);
  return map[chainId] ?? null;
}

const WELL_KNOWN_READ_ONLY_RPC: Record<number, string> = {
  1: "https://eth.llamarpc.com",
  [SEPOLIA_CHAIN_ID]: "https://rpc.sepolia.org",
  137: "https://polygon.llamarpc.com",
  8453: "https://mainnet.base.org",
  42161: "https://arb1.arbitrum.io/rpc",
};

/**
 * Get chain config for read-only use (e.g. balance). Uses config first, then well-known public RPCs.
 */
export function resolveWalletChainConfigForBalance(
  cfg: WalletIntegrationConfig,
  chainId: number,
): WalletConfig | null {
  const fromConfig = resolveWalletChainConfig(cfg, chainId);
  if (fromConfig) return fromConfig;
  const rpcUrl = WELL_KNOWN_READ_ONLY_RPC[chainId];
  if (rpcUrl) return { chainId, rpcUrl };
  return null;
}

const WELL_KNOWN_BLOCK_EXPLORER_BASE: Record<number, string> = {
  1: "https://etherscan.io",
  [SEPOLIA_CHAIN_ID]: "https://sepolia.etherscan.io",
  10: "https://optimistic.etherscan.io",
  137: "https://polygonscan.com",
  8453: "https://basescan.org",
  42161: "https://arbiscan.io",
  56: "https://bscscan.com",
  43114: "https://snowtrace.io",
  81457: "https://blastscan.org",
  324: "https://zkscan.io",
  59144: "https://lineascan.build",
  534352: "https://scrollscan.com",
};

/**
 * Get block explorer URL for a transaction.
 */
export function getBlockExplorerTxUrl(
  cfg: WalletIntegrationConfig,
  chainId: number,
  txHash: string,
): string | undefined {
  const hash = (txHash ?? "").trim().startsWith("0x") ? txHash.trim() : "0x" + txHash.trim();
  if (!hash || hash === "0x") return undefined;
  const chain = resolveWalletChainConfig(cfg, chainId);
  const base = chain?.blockExplorerUrl?.trim().replace(/\/$/, "") ?? WELL_KNOWN_BLOCK_EXPLORER_BASE[chainId];
  if (!base) return undefined;
  return `${base}/tx/${hash}`;
}

/**
 * Get block explorer URL for an address.
 */
export function getBlockExplorerAddressUrl(
  cfg: WalletIntegrationConfig,
  chainId: number,
  address: string,
): string | undefined {
  const addr = (address ?? "").trim().startsWith("0x") ? address.trim() : "0x" + address.trim();
  if (!addr || addr.length < 42) return undefined;
  const chain = resolveWalletChainConfig(cfg, chainId);
  const base = chain?.blockExplorerUrl?.trim().replace(/\/$/, "") ?? WELL_KNOWN_BLOCK_EXPLORER_BASE[chainId];
  if (!base) return undefined;
  return `${base}/address/${addr}`;
}

/**
 * Default chain config (for backward compat and single-chain use).
 */
export function resolveWalletConfig(cfg: WalletIntegrationConfig): WalletConfig | null {
  const map = resolveWalletChains(cfg);
  if (Object.keys(map).length === 0) {
    return { chainId: SEPOLIA_CHAIN_ID, rpcUrl: "https://rpc.sepolia.org" };
  }
  const defaultId = resolveDefaultChainId(cfg);
  return map[defaultId] ?? null;
}

export function getWalletsDir(stateDir?: string): string {
  const base = stateDir ?? resolveStateDir();
  return `${base.replace(/\/$/, "")}/wallets`;
}

/**
 * Create wallet service from config.
 * When no chains are configured, uses default Sepolia.
 */
export function createWalletServiceFromConfig(cfg: WalletIntegrationConfig): ReturnType<
  typeof createWalletService
> | null {
  let chains = resolveWalletChains(cfg);
  if (Object.keys(chains).length === 0) {
    chains = { [SEPOLIA_CHAIN_ID]: { chainId: SEPOLIA_CHAIN_ID, rpcUrl: "https://rpc.sepolia.org" } };
  }
  const defaultChainId = resolveDefaultChainId(cfg);
  const stateDir = resolveStateDir();
  return createWalletService({
    stateDir,
    chains,
    defaultChainId,
    limits: cfg.wallets?.defaults?.spending,
    notify: cfg.wallets?.notify,
    interactWithUnverifiedContracts: cfg.wallets?.interactWithUnverifiedContracts,
    verifiedTokenAddresses: cfg.wallets?.defaults?.verifiedTokenAddresses,
    verifiedContractAddresses: cfg.wallets?.defaults?.verifiedContractAddresses,
    platform: process.platform,
  });
}

/**
 * Initialize wallet at startup: if autoCreateOnStartup and no wallet exists, create one.
 */
export async function initWalletOnStartup(cfg: WalletIntegrationConfig): Promise<void> {
  const enabled = cfg.wallets?.autoCreateOnStartup === true;
  if (!enabled) return;
  const service = createWalletServiceFromConfig(cfg);
  if (!service) return;
  await service.ensureDefaultWallet();
}
