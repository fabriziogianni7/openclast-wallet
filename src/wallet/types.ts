/**
 * Native custodial wallet types.
 * Wallet is app-owned; keys stored in OS keychain.
 */

export type WalletId = string;

export type ChainId = number;

export type WalletMeta = {
  walletId: WalletId;
  address: string;
  chainId: ChainId;
  createdAt: number;
};

export type PendingTx = {
  txId: string;
  walletId: WalletId;
  chainId: ChainId;
  from: string;
  to: string;
  valueWei: string;
  data?: string;
  gasLimit?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce?: number;
  createdAt: number;
  status: "pending" | "approved" | "rejected" | "sent" | "failed";
  txHash?: string;
  error?: string;
};

export type WalletConfig = {
  chainId: ChainId;
  rpcUrl: string;
  /** Base URL for block explorer (e.g. https://etherscan.io). Use /tx/<hash> for tx links, /address/<address> for address links. */
  blockExplorerUrl?: string;
};

export type WalletsLimits = {
  mode?: "notify" | "auto";
  limitPerTx?: string;
  dailyLimit?: string;
  allowedChains?: number[];
  allowedRecipients?: string[];
  notifyChannels?: string[];
};

export type WalletState = {
  defaultWalletId: WalletId | null;
  wallets: Record<WalletId, WalletMeta>;
};

export const SEPOLIA_CHAIN_ID = 11155111;
