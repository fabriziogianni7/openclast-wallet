/**
 * Native custodial wallet service: keychain + state + pending + RPC.
 */

import { randomUUID } from "node:crypto";

import { getAddress, isAddress } from "viem";
import { createKeychainAdapter } from "./keychain.js";
import { createDailySpendStore, getTodayUtc } from "./daily-spend-store.js";
import { encodeErc20Approve, encodeErc20Transfer } from "./erc20.js";
import { createPendingStore } from "./pending-store.js";
import { createRpcClient, type RpcClient } from "./rpc.js";
import { createStateStore } from "./state-store.js";
import { buildAndSignTx, privateKeyToAddress } from "./tx-builder.js";
import { mnemonicToPrivateKeyHex } from "./mnemonic.js";
import type { PendingTx, WalletConfig, WalletMeta, WalletsLimits } from "./types.js";
import { createAuditLog, type AuditEntry, type AuditLogFilter } from "./audit.js";

function isContractAllowed(
  address: string,
  config: WalletServiceConfig,
): boolean {
  if (config.interactWithUnverifiedContracts !== false) return true;
  const normalized = address.trim().toLowerCase();
  const verified = [
    ...(config.verifiedTokenAddresses ?? []),
    ...(config.verifiedContractAddresses ?? []),
  ].map((a) => a.trim().toLowerCase());
  return verified.some((a) => a === normalized);
}

/**
 * Validate and normalize an EVM address. Uses viem isAddress (EIP-55 aware).
 * Returns the checksummed address or throws.
 * Sanitizes common LLM formatting artifacts (backticks, quotes, markdown).
 */
function validateAddress(raw: string, label: string): string {
  // Strip common LLM formatting artifacts: backticks, quotes, markdown bold/italic
  let sanitized = raw.trim().replace(/^[`'"*_]+|[`'"*_]+$/g, "").trim();
  // Also strip any zero-width / invisible unicode characters
  sanitized = sanitized.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "");
  if (!sanitized.startsWith("0x") || sanitized.length !== 42) {
    throw new Error(
      `Invalid ${label}: must be 42-char hex starting with 0x (got ${sanitized.length} chars: "${sanitized.slice(0, 50)}")`,
    );
  }
  if (!isAddress(sanitized)) {
    throw new Error(`Invalid ${label}: not a valid EVM address ("${sanitized}")`);
  }
  return getAddress(sanitized);
}

export type WalletServiceConfig = {
  stateDir: string;
  chains: Record<number, WalletConfig>;
  defaultChainId: number;
  limits?: WalletsLimits;
  notify?: { primaryChannel?: string };
  interactWithUnverifiedContracts?: boolean;
  verifiedTokenAddresses?: string[];
  verifiedContractAddresses?: string[];
  platform?: NodeJS.Platform;
};

export type WalletService = {
  ensureDefaultWallet(): Promise<WalletMeta | null>;
  createWallet(): Promise<WalletMeta>;
  importWallet(privateKeyHex: string): Promise<WalletMeta>;
  recoverFromMnemonic(mnemonic: string, accountIndex?: number): Promise<WalletMeta>;
  getAddress(walletId?: string): Promise<string | null>;
  getDefaultWalletId(): Promise<string | null>;
  listWallets(): Promise<{ defaultWalletId: string | null; wallets: WalletMeta[] }>;
  setDefaultWallet(walletId: string): Promise<WalletMeta>;
  requestSend(params: {
    walletId?: string;
    chainId?: number;
    to: string;
    valueWei: string;
  }): Promise<{ txId: string; pending: PendingTx }>;
  requestErc20Approve(params: {
    walletId?: string;
    chainId?: number;
    tokenAddress: string;
    spender: string;
    amountWei: string;
  }): Promise<{ txId: string; pending: PendingTx }>;
  requestErc20Transfer(params: {
    walletId?: string;
    chainId?: number;
    tokenAddress: string;
    to: string;
    amountWei: string;
  }): Promise<{ txId: string; pending: PendingTx }>;
  requestContractCall(params: {
    walletId?: string;
    chainId?: number;
    to: string;
    valueWei?: string;
    data: string;
    gasLimit?: string;
    gasPrice?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    nonce?: number;
  }): Promise<{ txId: string; pending: PendingTx }>;
  approveTx(txId: string): Promise<{ txHash: string; chainId: number } | { error: string }>;
  rejectTx(txId: string): Promise<{ ok: boolean; error?: string }>;
  getPendingTx(txId: string): Promise<PendingTx | null>;
  listPending(): Promise<PendingTx[]>;
  queryHistory(filter?: AuditLogFilter): Promise<AuditEntry[]>;
};

export function createWalletService(config: WalletServiceConfig): WalletService {
  const walletsDir = config.stateDir.replace(/\/$/, "") + "/wallets";
  const keychain = createKeychainAdapter(config.platform ?? process.platform);
  const stateStore = createStateStore(walletsDir);
  const pendingStore = createPendingStore(walletsDir);
  const audit = createAuditLog(walletsDir);
  const dailySpendStore = createDailySpendStore(walletsDir);
  const defaultChainId = config.defaultChainId;
  const limits = config.limits;
  const rpcByChain = new Map<number, RpcClient>();
  /** Pending transactions expire after 30 minutes (ms). */
  const PENDING_TX_TTL_MS = 30 * 60 * 1000;

  function getRpc(chainId: number): RpcClient {
    let rpc = rpcByChain.get(chainId);
    if (!rpc) {
      const chainConfig = config.chains[chainId];
      if (!chainConfig) throw new Error("Chain " + chainId + " not configured");
      rpc = createRpcClient(chainConfig.rpcUrl, chainConfig.chainId);
      rpcByChain.set(chainId, rpc);
    }
    return rpc;
  }

  async function getDefaultWalletId(): Promise<string | null> {
    const state = await stateStore.load();
    return state.defaultWalletId;
  }

  async function listWallets(): Promise<{ defaultWalletId: string | null; wallets: WalletMeta[] }> {
    const state = await stateStore.load();
    const wallets = Object.values(state.wallets).sort((a, b) => a.createdAt - b.createdAt);
    return { defaultWalletId: state.defaultWalletId, wallets };
  }

  async function setDefaultWallet(walletId: string): Promise<WalletMeta> {
    const state = await stateStore.load();
    const meta = state.wallets[walletId];
    if (!meta) throw new Error("Wallet not found");
    state.defaultWalletId = walletId;
    await stateStore.save(state);
    await audit.append({ action: "wallet_default_set", walletId, type: meta.type });
    return meta;
  }

  async function createWallet(): Promise<WalletMeta> {
    const { walletId, privateKeyHex } = keychain.createWallet();
    const address = privateKeyToAddress(privateKeyHex);
    const meta: WalletMeta = {
      walletId,
      address,
      type: "EVM",
      createdAt: Date.now(),
    };
    const state = await stateStore.load();
    state.wallets[walletId] = meta;
    if (!state.defaultWalletId) state.defaultWalletId = walletId;
    await stateStore.save(state);
    await audit.append({ action: "wallet_created", walletId, chainId: defaultChainId });
    return meta;
  }

  async function importWallet(privateKeyHex: string): Promise<WalletMeta> {
    const { walletId } = keychain.importWallet(privateKeyHex);
    const address = privateKeyToAddress(privateKeyHex);
    const meta: WalletMeta = {
      walletId,
      address,
      type: "EVM",
      createdAt: Date.now(),
    };
    const state = await stateStore.load();
    state.wallets[walletId] = meta;
    if (!state.defaultWalletId) state.defaultWalletId = walletId;
    await stateStore.save(state);
    await audit.append({ action: "wallet_imported", walletId, chainId: defaultChainId });
    return meta;
  }

  async function recoverFromMnemonic(mnemonic: string, accountIndex?: number): Promise<WalletMeta> {
    const privateKeyHex = mnemonicToPrivateKeyHex(mnemonic, accountIndex ?? 0);
    return importWallet(privateKeyHex);
  }

  async function getAddress(walletId?: string): Promise<string | null> {
    const state = await stateStore.load();
    const id = walletId ?? state.defaultWalletId;
    if (!id) return null;
    const meta = state.wallets[id];
    return meta?.address ?? null;
  }

  async function ensureDefaultWallet(): Promise<WalletMeta | null> {
    const state = await stateStore.load();
    if (state.defaultWalletId && state.wallets[state.defaultWalletId]) {
      return state.wallets[state.defaultWalletId];
    }
    return createWallet();
  }

  async function requestSend(params: {
    walletId?: string;
    chainId?: number;
    to: string;
    valueWei: string;
  }): Promise<{ txId: string; pending: PendingTx }> {
    const state = await stateStore.load();
    const walletId = params.walletId ?? state.defaultWalletId;
    if (!walletId) throw new Error("No default wallet");
    const meta = state.wallets[walletId];
    if (!meta) throw new Error("Wallet not found");
    const valueWei = BigInt(params.valueWei);
    if (valueWei <= 0n) throw new Error("Value must be positive");
    const to = validateAddress(params.to, "recipient address");
    const chainId = params.chainId ?? defaultChainId;
    if (!config.chains[chainId]) throw new Error(`Chain ${chainId} not configured`);

    if (limits?.allowedChains != null && limits.allowedChains.length > 0) {
      if (!limits.allowedChains.includes(chainId)) {
        throw new Error("Chain " + chainId + " not allowed (allowedChains)");
      }
    }
    if (limits?.allowedRecipients != null && limits.allowedRecipients.length > 0) {
      const normalized = to.toLowerCase();
      if (!limits.allowedRecipients.some((r) => r.trim().toLowerCase() === normalized)) {
        throw new Error("Recipient not in allowedRecipients");
      }
    }
    if (limits?.limitPerTx != null && limits.limitPerTx.trim() !== "") {
      const limit = BigInt(limits.limitPerTx.trim());
      if (valueWei > limit) throw new Error("Value exceeds limitPerTx (" + limits.limitPerTx + ")");
    }
    if (limits?.dailyLimit != null && limits.dailyLimit.trim() !== "") {
      const dayLimit = BigInt(limits.dailyLimit.trim());
      const today = getTodayUtc();
      const spent = await dailySpendStore.getTotalForDate(today);
      if (spent + valueWei > dayLimit) {
        throw new Error("Would exceed dailyLimit (" + limits.dailyLimit + ") for today");
      }
    }

    const txId = randomUUID();
    const pending: PendingTx = {
      txId,
      walletId,
      chainId,
      from: meta.address,
      to,
      valueWei: params.valueWei,
      createdAt: Date.now(),
      status: "pending",
    };
    await pendingStore.add(pending);
    await audit.append({
      action: "send_requested",
      txId,
      walletId,
      chainId,
      from: meta.address,
      to,
      valueWei: params.valueWei,
    });
    return { txId, pending };
  }

  async function requestErc20Approve(params: {
    walletId?: string;
    chainId?: number;
    tokenAddress: string;
    spender: string;
    amountWei: string;
  }): Promise<{ txId: string; pending: PendingTx }> {
    const tokenAddress = validateAddress(params.tokenAddress, "token address");
    if (!isContractAllowed(tokenAddress, config)) {
      throw new Error("Token not in verifiedTokenAddresses (set interactWithUnverifiedContracts or add to list)");
    }
    const state = await stateStore.load();
    const walletId = params.walletId ?? state.defaultWalletId;
    if (!walletId) throw new Error("No default wallet");
    const meta = state.wallets[walletId];
    if (!meta) throw new Error("Wallet not found");
    const chainId = params.chainId ?? defaultChainId;
    if (!config.chains[chainId]) throw new Error("Chain " + chainId + " not configured");
    const spender = validateAddress(params.spender, "spender address");
    const amountWei = BigInt(params.amountWei);
    const data = encodeErc20Approve(spender, amountWei);
    const txId = randomUUID();
    const pending: PendingTx = {
      txId,
      walletId,
      chainId,
      from: meta.address,
      to: tokenAddress,
      valueWei: "0",
      data,
      createdAt: Date.now(),
      status: "pending",
    };
    await pendingStore.add(pending);
    await audit.append({
      action: "erc20_approve_requested",
      txId,
      walletId,
      chainId,
      tokenAddress,
      spender,
      amountWei: params.amountWei,
    });
    return { txId, pending };
  }

  async function requestErc20Transfer(params: {
    walletId?: string;
    chainId?: number;
    tokenAddress: string;
    to: string;
    amountWei: string;
  }): Promise<{ txId: string; pending: PendingTx }> {
    const tokenAddress = validateAddress(params.tokenAddress, "token address");
    if (!isContractAllowed(tokenAddress, config)) {
      throw new Error("Token not in verifiedTokenAddresses (set interactWithUnverifiedContracts or add to list)");
    }
    const state = await stateStore.load();
    const walletId = params.walletId ?? state.defaultWalletId;
    if (!walletId) throw new Error("No default wallet");
    const meta = state.wallets[walletId];
    if (!meta) throw new Error("Wallet not found");
    const chainId = params.chainId ?? defaultChainId;
    if (!config.chains[chainId]) throw new Error("Chain " + chainId + " not configured");
    const to = validateAddress(params.to, "recipient address");
    const amountWei = BigInt(params.amountWei);
    if (amountWei <= 0n) throw new Error("Amount must be positive");
    if (limits?.allowedChains != null && limits.allowedChains.length > 0) {
      if (!limits.allowedChains.includes(chainId)) {
        throw new Error("Chain " + chainId + " not allowed (allowedChains)");
      }
    }
    if (limits?.allowedRecipients != null && limits.allowedRecipients.length > 0) {
      const normalized = to.toLowerCase();
      if (!limits.allowedRecipients.some((r) => r.trim().toLowerCase() === normalized)) {
        throw new Error("Recipient not in allowedRecipients");
      }
    }
    const data = encodeErc20Transfer(to, amountWei);
    const txId = randomUUID();
    const pending: PendingTx = {
      txId,
      walletId,
      chainId,
      from: meta.address,
      to: tokenAddress,
      valueWei: "0",
      data,
      createdAt: Date.now(),
      status: "pending",
    };
    await pendingStore.add(pending);
    await audit.append({
      action: "erc20_transfer_requested",
      txId,
      walletId,
      chainId,
      tokenAddress,
      to,
      amountWei: params.amountWei,
    });
    return { txId, pending };
  }

  async function requestContractCall(params: {
    walletId?: string;
    chainId?: number;
    to: string;
    valueWei?: string;
    data: string;
    gasLimit?: string;
    gasPrice?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    nonce?: number;
  }): Promise<{ txId: string; pending: PendingTx }> {
    const to = validateAddress(params.to, "contract address");
    if (!isContractAllowed(to, config)) {
      throw new Error(
        "Contract not in verifiedContractAddresses/verifiedTokenAddresses (set interactWithUnverifiedContracts or add to list)",
      );
    }
    const state = await stateStore.load();
    const walletId = params.walletId ?? state.defaultWalletId;
    if (!walletId) throw new Error("No default wallet");
    const meta = state.wallets[walletId];
    if (!meta) throw new Error("Wallet not found");
    const chainId = params.chainId ?? defaultChainId;
    if (!config.chains[chainId]) throw new Error("Chain " + chainId + " not configured");
    const valueWei = (params.valueWei ?? "0").trim();
    const valueBigInt = BigInt(valueWei);
    if (valueBigInt < 0n) throw new Error("valueWei must be non-negative");
    const data = (params.data ?? "").trim();
    if (!data.startsWith("0x")) throw new Error("data must be hex (0x...)");
    const gasLimit = params.gasLimit?.trim();
    if (gasLimit != null && gasLimit !== "") {
      const gasLimitBigInt = BigInt(gasLimit);
      if (gasLimitBigInt <= 0n) throw new Error("gasLimit must be positive");
    }
    const gasPrice = params.gasPrice?.trim();
    if (gasPrice != null && gasPrice !== "") {
      const gasPriceBigInt = BigInt(gasPrice);
      if (gasPriceBigInt <= 0n) throw new Error("gasPrice must be positive");
    }
    const maxFeePerGas = params.maxFeePerGas?.trim();
    if (maxFeePerGas != null && maxFeePerGas !== "") {
      const maxFeePerGasBigInt = BigInt(maxFeePerGas);
      if (maxFeePerGasBigInt <= 0n) throw new Error("maxFeePerGas must be positive");
    }
    const maxPriorityFeePerGas = params.maxPriorityFeePerGas?.trim();
    if (maxPriorityFeePerGas != null && maxPriorityFeePerGas !== "") {
      const maxPriorityFeePerGasBigInt = BigInt(maxPriorityFeePerGas);
      if (maxPriorityFeePerGasBigInt <= 0n) throw new Error("maxPriorityFeePerGas must be positive");
    }
    const nonce = params.nonce;
    if (nonce != null && (!Number.isInteger(nonce) || nonce < 0)) {
      throw new Error("nonce must be a non-negative integer");
    }
    if (limits?.allowedChains != null && limits.allowedChains.length > 0) {
      if (!limits.allowedChains.includes(chainId)) {
        throw new Error("Chain " + chainId + " not allowed (allowedChains)");
      }
    }
    if (limits?.allowedRecipients != null && limits.allowedRecipients.length > 0) {
      const normalized = to.toLowerCase();
      if (!limits.allowedRecipients.some((r) => r.trim().toLowerCase() === normalized)) {
        throw new Error("Recipient not in allowedRecipients");
      }
    }
    if (limits?.limitPerTx != null && limits.limitPerTx.trim() !== "") {
      const limit = BigInt(limits.limitPerTx);
      if (valueBigInt > limit) {
        throw new Error("valueWei exceeds limitPerTx");
      }
    }
    if (limits?.dailyLimit != null && limits.dailyLimit.trim() !== "" && valueBigInt > 0n) {
      const today = getTodayUtc();
      const current = await dailySpendStore.getTotalForDate(today);
      const limit = BigInt(limits.dailyLimit);
      if (current + valueBigInt > limit) {
        throw new Error("Would exceed dailyLimit");
      }
    }
    const txId = randomUUID();
    const pending: PendingTx = {
      txId,
      walletId,
      chainId,
      from: meta.address,
      to,
      valueWei,
      data,
      ...(gasLimit ? { gasLimit } : {}),
      ...(gasPrice ? { gasPrice } : {}),
      ...(maxFeePerGas ? { maxFeePerGas } : {}),
      ...(maxPriorityFeePerGas ? { maxPriorityFeePerGas } : {}),
      ...(nonce != null ? { nonce } : {}),
      createdAt: Date.now(),
      status: "pending",
    };
    await pendingStore.add(pending);
    await audit.append({
      action: "contract_call_requested",
      txId,
      walletId,
      chainId,
      to,
      valueWei,
    });
    return { txId, pending };
  }

  async function approveTx(txId: string): Promise<{ txHash: string; chainId: number } | { error: string }> {
    const pending = await pendingStore.get(txId);
    if (!pending) return { error: "Pending tx not found" };
    if (pending.status !== "pending") return { error: "Tx status is " + pending.status };
    // Expiration check: reject stale pending transactions
    const age = Date.now() - pending.createdAt;
    if (age > PENDING_TX_TTL_MS) {
      await pendingStore.update(txId, { status: "failed", error: "Pending tx expired (>30min)" });
      await audit.append({
        action: "send_expired",
        txId,
        walletId: pending.walletId,
        chainId: pending.chainId,
      });
      return { error: "Pending tx expired. Create a new transaction." };
    }
    // Optimistic lock: mark as "approved" immediately to prevent double-approval.
    // If another concurrent call already changed the status, this re-check catches it.
    const freshCheck = await pendingStore.get(txId);
    if (!freshCheck || freshCheck.status !== "pending") {
      return { error: "Tx already processed (status: " + (freshCheck?.status ?? "unknown") + ")" };
    }
    await pendingStore.update(txId, { status: "approved" });

    const privateKey = keychain.getPrivateKey(pending.walletId);
    if (!privateKey) {
      await pendingStore.update(txId, { status: "failed", error: "Cannot read wallet key" });
      return { error: "Cannot read wallet key" };
    }
    const rpc = getRpc(pending.chainId);
    try {
      const txParams = {
        privateKeyHex: privateKey,
        chainId: pending.chainId,
        to: pending.to,
        valueWei: BigInt(pending.valueWei),
        data: pending.data,
        gasLimit: pending.gasLimit != null ? BigInt(pending.gasLimit) : undefined,
        gasPrice: pending.gasPrice != null ? BigInt(pending.gasPrice) : undefined,
        maxFeePerGas: pending.maxFeePerGas != null ? BigInt(pending.maxFeePerGas) : undefined,
        maxPriorityFeePerGas:
          pending.maxPriorityFeePerGas != null ? BigInt(pending.maxPriorityFeePerGas) : undefined,
        nonce: pending.nonce,
        rpc,
      };
      const { signedHex } = await buildAndSignTx(txParams);
      const txHash = await rpc.sendRawTransaction(signedHex);
      await pendingStore.update(txId, { status: "sent", txHash });
      if (limits?.dailyLimit != null && limits.dailyLimit.trim() !== "") {
        const today = getTodayUtc();
        await dailySpendStore.addSpend(today, BigInt(pending.valueWei));
      }
      await audit.append({
        action: "send_approved",
        txId,
        walletId: pending.walletId,
        chainId: pending.chainId,
        from: pending.from,
        to: pending.to,
        valueWei: pending.valueWei,
        txHash,
      });
      return { txHash, chainId: pending.chainId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await pendingStore.update(txId, { status: "failed", error: message });
      await audit.append({
        action: "send_failed",
        txId,
        walletId: pending.walletId,
        chainId: pending.chainId,
        error: message,
      });
      return { error: message };
    }
  }

  async function rejectTx(txId: string): Promise<{ ok: boolean; error?: string }> {
    const pending = await pendingStore.get(txId);
    if (!pending) return { ok: false, error: "Pending tx not found" };
    if (pending.status !== "pending") return { ok: false, error: "Tx status is " + pending.status };
    await pendingStore.update(txId, { status: "rejected" });
    await audit.append({
      action: "send_rejected",
      txId,
      walletId: pending.walletId,
      chainId: pending.chainId,
      from: pending.from,
      to: pending.to,
      valueWei: pending.valueWei,
    });
    return { ok: true };
  }

  async function getPendingTx(txId: string): Promise<PendingTx | null> {
    return pendingStore.get(txId);
  }

  async function listPending(): Promise<PendingTx[]> {
    const items = await pendingStore.load();
    return items.filter((t) => t.status === "pending");
  }

  async function queryHistory(filter?: AuditLogFilter): Promise<AuditEntry[]> {
    return audit.query(filter);
  }

  return {
    ensureDefaultWallet,
    createWallet,
    importWallet,
    recoverFromMnemonic,
    getAddress,
    getDefaultWalletId,
    listWallets,
    setDefaultWallet,
    requestSend,
    requestErc20Approve,
    requestErc20Transfer,
    requestContractCall,
    approveTx,
    rejectTx,
    getPendingTx,
    listPending,
    queryHistory,
  };
}
