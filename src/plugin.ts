import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import { jsonResult } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  createRpcClient,
  createWalletServiceFromConfig,
  getBlockExplorerAddressUrl,
  getBlockExplorerTxUrl,
  initWalletOnStartup,
  resolveDefaultChainId,
  resolveWalletChainConfigForBalance,
  type WalletIntegrationConfig,
  type WalletService,
} from "./wallet/index.js";
import { getTokenBalances } from "./wallet/token-balances.js";

type PluginConfig = WalletIntegrationConfig;

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function loadConfigFromPath(filePath: string): PluginConfig {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return normalizePluginConfig(parsed);
}

function normalizePluginConfig(value: unknown): PluginConfig {
  if (typeof value === "string") {
    return loadConfigFromPath(value);
  }
  if (!isObject(value)) {
    return {};
  }
  const maybeConfigPath = value["configPath"];
  if (typeof maybeConfigPath === "string") {
    return loadConfigFromPath(maybeConfigPath);
  }
  if ("wallets" in value) {
    return value as PluginConfig;
  }
  return { wallets: value as PluginConfig["wallets"] };
}

const walletPluginConfigSchema = {
  parse(value: unknown): PluginConfig {
    return normalizePluginConfig(value);
  },
  uiHints: {
    "wallets.autoCreateOnStartup": { label: "Auto-create wallet on startup" },
    "wallets.defaults.spending.mode": { label: "Spending mode", advanced: true },
    "wallets.defaults.spending.limitPerTx": { label: "Per-tx limit (wei)" },
    "wallets.defaults.spending.dailyLimit": { label: "Daily limit (wei)" },
    "wallets.defaults.spending.allowedChains": { label: "Allowed chains", advanced: true },
    "wallets.defaults.spending.allowedRecipients": { label: "Allowed recipients", advanced: true },
    "wallets.notify.primaryChannel": { label: "Notify channel" },
  },
};

const walletAddressSchema = Type.Object({
  walletId: Type.Optional(Type.String({ description: "Wallet id override" })),
  chainId: Type.Optional(Type.Number({ description: "Chain id for explorer link" })),
});

const walletBalanceSchema = Type.Object({
  walletId: Type.Optional(Type.String({ description: "Wallet id override" })),
  chainId: Type.Optional(Type.Number({ description: "Chain id for balance" })),
  includeTokens: Type.Optional(Type.Boolean({ description: "Include known ERC20 balances" })),
});

const walletCreateSchema = Type.Object({});

const walletListSchema = Type.Object({});

const walletSendSchema = Type.Object({
  walletId: Type.Optional(Type.String({ description: "Wallet id override" })),
  chainId: Type.Optional(Type.Number({ description: "Chain id override" })),
  to: Type.String({ description: "Recipient address (0x...)" }),
  valueWei: Type.String({ description: "Amount in wei" }),
});

const walletApproveSchema = Type.Object({
  txId: Type.String({ description: "Pending tx id to approve" }),
});

const walletTxStatusSchema = Type.Object({
  txId: Type.String({ description: "Pending tx id" }),
});

const walletErc20ApproveSchema = Type.Object({
  walletId: Type.Optional(Type.String({ description: "Wallet id override" })),
  chainId: Type.Optional(Type.Number({ description: "Chain id override" })),
  tokenAddress: Type.String({ description: "ERC20 contract address (0x...)" }),
  spender: Type.String({ description: "Spender address (0x...)" }),
  amountWei: Type.String({ description: "Allowance in wei" }),
});

const walletErc20TransferSchema = Type.Object({
  walletId: Type.Optional(Type.String({ description: "Wallet id override" })),
  chainId: Type.Optional(Type.Number({ description: "Chain id override" })),
  tokenAddress: Type.String({ description: "ERC20 contract address (0x...)" }),
  to: Type.String({ description: "Recipient address (0x...)" }),
  amountWei: Type.String({ description: "Amount in wei" }),
});

const walletContractCallSchema = Type.Object({
  walletId: Type.Optional(Type.String({ description: "Wallet id override" })),
  chainId: Type.Optional(Type.Number({ description: "Chain id override" })),
  to: Type.String({ description: "Contract address (0x...)" }),
  valueWei: Type.Optional(Type.String({ description: "ETH value in wei" })),
  data: Type.String({ description: "Calldata (0x...)" }),
  gasLimit: Type.Optional(Type.String({ description: "Gas limit override" })),
  gasPrice: Type.Optional(Type.String({ description: "Legacy gas price (wei)" })),
  maxFeePerGas: Type.Optional(Type.String({ description: "EIP-1559 max fee (wei)" })),
  maxPriorityFeePerGas: Type.Optional(
    Type.String({ description: "EIP-1559 priority fee (wei)" }),
  ),
  nonce: Type.Optional(Type.Number({ description: "Nonce override" })),
});

const walletSetDefaultSchema = Type.Object({
  walletId: Type.String({ description: "Wallet id to set as default" }),
});

const walletPlugin = {
  id: "openclast-wallet",
  name: "Openclast Wallet",
  description: "Native custodial EVM wallet with OS keychain + approval flow.",
  configSchema: walletPluginConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = walletPluginConfigSchema.parse(api.pluginConfig);
    let service: WalletService | null = null;

    const ensureService = () => {
      if (service) return service;
      const created = createWalletServiceFromConfig(config);
      if (!created) {
        throw new Error("Invalid wallet config: unable to initialize wallet service.");
      }
      service = created;
      return created;
    };

    const withErrors =
      (handler: (params: Record<string, unknown>) => Promise<unknown>) =>
      async (_toolCallId: string, params: Record<string, unknown>) => {
        try {
          return jsonResult(await handler(params));
        } catch (error) {
          return jsonResult({ error: error instanceof Error ? error.message : String(error) });
        }
      };

    api.registerTool({
      name: "wallet_address",
      label: "Wallet Address",
      description: "Get the default wallet address (or an explicit walletId).",
      parameters: walletAddressSchema,
      execute: withErrors(async (params) => {
        const svc = ensureService();
        const walletId = typeof params.walletId === "string" ? params.walletId : undefined;
        const address = await svc.getAddress(walletId);
        if (!address) {
          throw new Error("No wallet address available.");
        }
        const chainId =
          typeof params.chainId === "number" ? params.chainId : resolveDefaultChainId(config);
        return {
          address,
          walletId: walletId ?? (await svc.getDefaultWalletId()),
          chainId,
          explorerUrl: getBlockExplorerAddressUrl(config, chainId, address),
        };
      }),
    });

    api.registerTool({
      name: "wallet_balance",
      label: "Wallet Balance",
      description: "Fetch native balance (and optional known ERC20 balances).",
      parameters: walletBalanceSchema,
      execute: withErrors(async (params) => {
        const svc = ensureService();
        const walletId = typeof params.walletId === "string" ? params.walletId : undefined;
        const address = await svc.getAddress(walletId);
        if (!address) {
          throw new Error("No wallet address available.");
        }
        const chainId =
          typeof params.chainId === "number" ? params.chainId : resolveDefaultChainId(config);
        const chainConfig = resolveWalletChainConfigForBalance(config, chainId);
        if (!chainConfig) {
          throw new Error(`Chain ${chainId} not configured and no public RPC available.`);
        }
        const rpc = createRpcClient(chainConfig.rpcUrl, chainId);
        const balance = await rpc.getBalance(address);
        const includeTokens = params.includeTokens === true;
        const tokens = includeTokens
          ? await getTokenBalances(rpc.publicClient, chainId, address)
          : [];
        return {
          address,
          chainId,
          balanceWei: balance.toString(),
          tokens,
          explorerUrl: getBlockExplorerAddressUrl(config, chainId, address),
        };
      }),
    });

    api.registerTool({
      name: "wallet_create",
      label: "Wallet Create",
      description: "Create a new wallet (address only; keys are never exposed).",
      parameters: walletCreateSchema,
      execute: withErrors(async () => {
        const svc = ensureService();
        const meta = await svc.createWallet();
        return {
          walletId: meta.walletId,
          address: meta.address,
          chainId: meta.chainId,
          createdAt: meta.createdAt,
        };
      }),
    });

    api.registerTool({
      name: "wallet_list",
      label: "Wallet List",
      description: "List known wallets and the current default wallet.",
      parameters: walletListSchema,
      execute: withErrors(async () => {
        const svc = ensureService();
        const { wallets, defaultWalletId } = await svc.listWallets();
        return {
          defaultWalletId,
          wallets: wallets.map((wallet) => ({
            ...wallet,
            isDefault: wallet.walletId === defaultWalletId,
          })),
        };
      }),
    });

    api.registerTool({
      name: "wallet_setDefault",
      label: "Wallet Set Default",
      description: "Set the default wallet by id.",
      parameters: walletSetDefaultSchema,
      execute: withErrors(async (params) => {
        const svc = ensureService();
        const walletId = typeof params.walletId === "string" ? params.walletId : "";
        if (!walletId) {
          throw new Error("walletId is required");
        }
        const meta = await svc.setDefaultWallet(walletId);
        return {
          walletId: meta.walletId,
          address: meta.address,
          chainId: meta.chainId,
          createdAt: meta.createdAt,
        };
      }),
    });

    api.registerTool({
      name: "wallet_send",
      label: "Wallet Send",
      description: "Create a pending send transaction that must be approved.",
      parameters: walletSendSchema,
      execute: withErrors(async (params) => {
        const svc = ensureService();
        const to = typeof params.to === "string" ? params.to : "";
        const valueWei = typeof params.valueWei === "string" ? params.valueWei : "";
        const chainId = typeof params.chainId === "number" ? params.chainId : undefined;
        const walletId = typeof params.walletId === "string" ? params.walletId : undefined;
        const result = await svc.requestSend({ walletId, chainId, to, valueWei });
        return { txId: result.txId, pending: result.pending };
      }),
    });

    api.registerTool({
      name: "wallet_erc20_approve",
      label: "Wallet ERC20 Approve",
      description: "Create a pending ERC20 approve transaction.",
      parameters: walletErc20ApproveSchema,
      execute: withErrors(async (params) => {
        const svc = ensureService();
        const tokenAddress = typeof params.tokenAddress === "string" ? params.tokenAddress : "";
        const spender = typeof params.spender === "string" ? params.spender : "";
        const amountWei = typeof params.amountWei === "string" ? params.amountWei : "";
        const chainId = typeof params.chainId === "number" ? params.chainId : undefined;
        const walletId = typeof params.walletId === "string" ? params.walletId : undefined;
        const result = await svc.requestErc20Approve({
          walletId,
          chainId,
          tokenAddress,
          spender,
          amountWei,
        });
        return { txId: result.txId, pending: result.pending };
      }),
    });

    api.registerTool({
      name: "wallet_erc20_transfer",
      label: "Wallet ERC20 Transfer",
      description: "Create a pending ERC20 transfer transaction.",
      parameters: walletErc20TransferSchema,
      execute: withErrors(async (params) => {
        const svc = ensureService();
        const tokenAddress = typeof params.tokenAddress === "string" ? params.tokenAddress : "";
        const to = typeof params.to === "string" ? params.to : "";
        const amountWei = typeof params.amountWei === "string" ? params.amountWei : "";
        const chainId = typeof params.chainId === "number" ? params.chainId : undefined;
        const walletId = typeof params.walletId === "string" ? params.walletId : undefined;
        const result = await svc.requestErc20Transfer({
          walletId,
          chainId,
          tokenAddress,
          to,
          amountWei,
        });
        return { txId: result.txId, pending: result.pending };
      }),
    });

    api.registerTool({
      name: "wallet_contract_call",
      label: "Wallet Contract Call",
      description: "Create a pending contract call transaction.",
      parameters: walletContractCallSchema,
      execute: withErrors(async (params) => {
        const svc = ensureService();
        const to = typeof params.to === "string" ? params.to : "";
        const data = typeof params.data === "string" ? params.data : "";
        const valueWei = typeof params.valueWei === "string" ? params.valueWei : undefined;
        const gasLimit = typeof params.gasLimit === "string" ? params.gasLimit : undefined;
        const gasPrice = typeof params.gasPrice === "string" ? params.gasPrice : undefined;
        const maxFeePerGas =
          typeof params.maxFeePerGas === "string" ? params.maxFeePerGas : undefined;
        const maxPriorityFeePerGas =
          typeof params.maxPriorityFeePerGas === "string"
            ? params.maxPriorityFeePerGas
            : undefined;
        const nonce = typeof params.nonce === "number" ? params.nonce : undefined;
        const chainId = typeof params.chainId === "number" ? params.chainId : undefined;
        const walletId = typeof params.walletId === "string" ? params.walletId : undefined;
        const result = await svc.requestContractCall({
          walletId,
          chainId,
          to,
          valueWei,
          data,
          gasLimit,
          gasPrice,
          maxFeePerGas,
          maxPriorityFeePerGas,
          nonce,
        });
        return { txId: result.txId, pending: result.pending };
      }),
    });

    api.registerTool({
      name: "wallet_txStatus",
      label: "Wallet Transaction Status",
      description: "Get the status of a pending transaction (pending=awaiting approval).",
      parameters: walletTxStatusSchema,
      execute: withErrors(async (params) => {
        const svc = ensureService();
        const txId = typeof params.txId === "string" ? params.txId : "";
        const pending = await svc.getPendingTx(txId);
        if (!pending) {
          return { found: false };
        }
        const statusLabel = pending.status === "pending" ? "awaiting approval" : pending.status;
        let statusNote: string | undefined;
        switch (pending.status) {
          case "pending":
            statusNote = "Pending means awaiting user approval; it has not been broadcast.";
            break;
          case "sent":
            statusNote = "Sent means broadcast to the network; it may still be unconfirmed.";
            break;
          case "failed":
            statusNote = "Failed means signing or broadcast failed.";
            break;
          case "rejected":
            statusNote = "Rejected means the pending transaction was declined.";
            break;
          default:
            statusNote = undefined;
        }
        return {
          found: true,
          pending,
          statusLabel,
          statusNote,
          explorerUrl:
            pending.txHash != null
              ? getBlockExplorerTxUrl(config, pending.chainId, pending.txHash)
              : undefined,
        };
      }),
    });

    api.registerTool({
      name: "wallet_approve",
      label: "Wallet Approve Transaction",
      description: "Approve and broadcast a pending transaction.",
      parameters: walletApproveSchema,
      execute: withErrors(async (params) => {
        const svc = ensureService();
        const txId = typeof params.txId === "string" ? params.txId : "";
        const result = await svc.approveTx(txId);
        if ("error" in result) {
          return { ok: false, error: result.error };
        }
        return {
          ok: true,
          txHash: result.txHash,
          chainId: result.chainId,
          explorerUrl: getBlockExplorerTxUrl(config, result.chainId, result.txHash),
        };
      }),
    });

    api.registerService({
      id: "openclast-wallet",
      start: async () => {
        try {
          await initWalletOnStartup(config);
        } catch (error) {
          api.logger.error(
            `[openclast-wallet] Failed to auto-create wallet: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      },
      stop: async () => {
        service = null;
      },
    });
  },
};

export default walletPlugin;
