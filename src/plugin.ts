import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import { jsonResult } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  createEncryptedFileKeychainAdapter,
  createRpcClient,
  createWalletService,
  getBlockExplorerAddressUrl,
  getBlockExplorerTxUrl,
  resolveDefaultChainId,
  resolveStateDirForPeer,
  resolveWalletChainConfigForBalance,
  resolveWalletChains,
  SEPOLIA_CHAIN_ID,
  type WalletIntegrationConfig,
  type WalletService,
} from "./wallet/index.js";
import { getTokenBalances } from "./wallet/token-balances.js";

type PluginConfig = WalletIntegrationConfig;

/** Context passed to tool factories by OpenClaw (sessionKey format: agent:<agentId>:telegram:dm:<peerId>) */
type ToolContext = { sessionKey?: string };

function extractPeerId(sessionKey?: string): string {
  if (!sessionKey) return "default";
  const parts = sessionKey.split(":");
  const dmIdx = parts.indexOf("dm");
  return dmIdx >= 0 && parts[dmIdx + 1] ? parts[dmIdx + 1]! : "default";
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function readChainId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = trimmed.startsWith("0x")
      ? Number.parseInt(trimmed, 16)
      : Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Normalize a value that could be hex ("0x...") or decimal string to a decimal wei string.
 * Handles the format returned by LI.FI and other protocol APIs.
 */
function hexOrDecToWei(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "number") return String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "0x" || trimmed === "0x0" || trimmed === "0") return "0";
    if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
      try {
        return BigInt(trimmed).toString();
      } catch {
        return undefined;
      }
    }
    // Already decimal
    return trimmed;
  }
  return undefined;
}

/**
 * Parse a human-readable amount into wei.
 * Accepts `amount` + `unit` (e.g. "0.1" + "ether") or falls back to raw `valueWei`/`amountWei`.
 * Supported units: wei, kwei, mwei, gwei, szabo, finney, ether.
 * Also supports integer `decimals` for ERC20 (e.g. amount "100" with decimals 6 => 100_000_000).
 */
const UNIT_DECIMALS: Record<string, number> = {
  wei: 0,
  kwei: 3,
  mwei: 6,
  gwei: 9,
  szabo: 12,
  finney: 15,
  ether: 18,
  eth: 18,
};

function parseHumanAmount(params: Record<string, unknown>, weiKey: string): string | undefined {
  // If raw wei is provided, use it directly
  const rawWei = params[weiKey];
  if (typeof rawWei === "string" && rawWei.trim()) return rawWei.trim();

  const amount = params.amount;
  if (typeof amount !== "string" && typeof amount !== "number") return undefined;
  const amountStr = String(amount).trim();
  if (!amountStr) return undefined;

  // Determine decimals: from unit name or explicit `decimals` param
  let decimals = 18; // default to ether
  const unit = typeof params.unit === "string" ? params.unit.trim().toLowerCase() : undefined;
  const explicitDecimals = typeof params.decimals === "number" ? params.decimals : undefined;

  if (unit && UNIT_DECIMALS[unit] != null) {
    decimals = UNIT_DECIMALS[unit];
  } else if (explicitDecimals != null) {
    decimals = explicitDecimals;
  } else if (unit) {
    // Unknown unit, try parsing as number of decimals
    const parsed = Number.parseInt(unit, 10);
    if (Number.isFinite(parsed) && parsed >= 0) decimals = parsed;
  }

  return parseUnitsToWei(amountStr, decimals);
}

/**
 * Parse a decimal string to wei given a number of decimals.
 * e.g. parseUnitsToWei("1.5", 18) => "1500000000000000000"
 */
function parseUnitsToWei(amount: string, decimals: number): string {
  const negative = amount.startsWith("-");
  const abs = negative ? amount.slice(1) : amount;
  const parts = abs.split(".");
  const whole = parts[0] || "0";
  const frac = (parts[1] || "").slice(0, decimals).padEnd(decimals, "0");
  const raw = whole + frac;
  // Remove leading zeros but keep at least one digit
  const trimmed = raw.replace(/^0+/, "") || "0";
  return negative ? "-" + trimmed : trimmed;
}

/* ------------------------------------------------------------------ */
/*  Config loading                                                    */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Shared amount description text                                    */
/* ------------------------------------------------------------------ */

const AMOUNT_DESCRIPTION =
  'Human-readable amount (e.g. "0.1"). Interpreted using `unit` or `decimals`. Defaults to ether (18 decimals).';
const UNIT_DESCRIPTION =
  'Unit for `amount`: wei, kwei, mwei, gwei, szabo, finney, ether/eth. Ignored when raw wei field is provided.';

/* ------------------------------------------------------------------ */
/*  Tool schemas                                                      */
/* ------------------------------------------------------------------ */

const walletAddressSchema = Type.Object({
  walletId: Type.Optional(Type.String({ description: "Wallet id override" })),
  chainId: Type.Optional(Type.Number({ description: "Chain id for explorer link" })),
});

const walletBalanceSchema = Type.Object({
  walletId: Type.Optional(Type.String({ description: "Wallet id override" })),
  chainId: Type.Optional(Type.Number({ description: "Chain id for balance" })),
  includeTokens: Type.Optional(Type.Boolean({ description: "Include known ERC20 balances" })),
  tokenAddress: Type.Optional(
    Type.String({ description: "Arbitrary ERC20 address to query balance for" }),
  ),
  allChains: Type.Optional(
    Type.Boolean({ description: "Fetch balances across all configured chains" }),
  ),
});

const walletCreateSchema = Type.Object({});

const walletListSchema = Type.Object({});

const walletSendSchema = Type.Object({
  walletId: Type.Optional(Type.String({ description: "Wallet id override" })),
  chainId: Type.Optional(Type.Number({ description: "Target chain id. ALWAYS extract from user message (e.g. 'on Base' → 8453, 'on Polygon' → 137, 'on Arbitrum' → 42161, 'on Ethereum' → 1). Only omit if user does not mention any chain." })),
  to: Type.String({ description: "Recipient address (0x...)" }),
  valueWei: Type.Optional(Type.String({ description: "Amount in wei (use `amount`+`unit` instead for human-readable)" })),
  amount: Type.Optional(Type.String({ description: AMOUNT_DESCRIPTION })),
  unit: Type.Optional(Type.String({ description: UNIT_DESCRIPTION })),
});

const walletApproveSchema = Type.Object({
  txId: Type.String({ description: "Pending tx id to approve" }),
});

const walletRejectSchema = Type.Object({
  txId: Type.String({ description: "Pending tx id to reject" }),
});

const walletTxStatusSchema = Type.Object({
  txId: Type.String({ description: "Pending tx id" }),
});

const walletListPendingSchema = Type.Object({});

const walletErc20ApproveSchema = Type.Object({
  walletId: Type.Optional(Type.String({ description: "Wallet id override" })),
  chainId: Type.Optional(Type.Number({ description: "Target chain id. ALWAYS extract from user message (e.g. 'on Base' → 8453, 'on Polygon' → 137, 'on Arbitrum' → 42161, 'on Ethereum' → 1). Only omit if user does not mention any chain." })),
  tokenAddress: Type.String({ description: "ERC20 contract address (0x...)" }),
  spender: Type.String({ description: "Spender address (0x...)" }),
  amountWei: Type.Optional(Type.String({ description: "Allowance in wei (use `amount`+`unit` instead for human-readable)" })),
  amount: Type.Optional(Type.String({ description: AMOUNT_DESCRIPTION })),
  unit: Type.Optional(Type.String({ description: UNIT_DESCRIPTION })),
  decimals: Type.Optional(Type.Number({ description: "Token decimals (e.g. 6 for USDC). Overrides `unit`." })),
});

const walletErc20TransferSchema = Type.Object({
  walletId: Type.Optional(Type.String({ description: "Wallet id override" })),
  chainId: Type.Optional(Type.Number({ description: "Target chain id. ALWAYS extract from user message (e.g. 'on Base' → 8453, 'on Polygon' → 137, 'on Arbitrum' → 42161, 'on Ethereum' → 1). Only omit if user does not mention any chain." })),
  tokenAddress: Type.String({ description: "ERC20 contract address (0x...)" }),
  to: Type.String({ description: "Recipient address (0x...)" }),
  amountWei: Type.Optional(Type.String({ description: "Amount in wei (use `amount`+`unit` instead for human-readable)" })),
  amount: Type.Optional(Type.String({ description: AMOUNT_DESCRIPTION })),
  unit: Type.Optional(Type.String({ description: UNIT_DESCRIPTION })),
  decimals: Type.Optional(Type.Number({ description: "Token decimals (e.g. 6 for USDC). Overrides `unit`." })),
});

// Simplified: flat params only, no nested transactionRequest
const walletContractCallSchema = Type.Object({
  walletId: Type.Optional(Type.String({ description: "Wallet id override" })),
  chainId: Type.Optional(Type.Number({ description: "Target chain id. ALWAYS extract from user message (e.g. 'on Base' → 8453, 'on Polygon' → 137, 'on Arbitrum' → 42161, 'on Ethereum' → 1). Only omit if user does not mention any chain." })),
  to: Type.String({ description: "Contract address (0x...)" }),
  data: Type.String({ description: "Calldata hex (0x...). Use wallet_encodeCall to build this." }),
  valueWei: Type.Optional(Type.String({ description: "ETH value in wei (use `amount`+`unit` instead for human-readable)" })),
  amount: Type.Optional(Type.String({ description: AMOUNT_DESCRIPTION })),
  unit: Type.Optional(Type.String({ description: UNIT_DESCRIPTION })),
  gasLimit: Type.Optional(Type.String({ description: "Gas limit override" })),
  nonce: Type.Optional(Type.Number({ description: "Nonce override" })),
});

const walletSetDefaultSchema = Type.Object({
  walletId: Type.String({ description: "Wallet id to set as default" }),
});

const walletReadContractSchema = Type.Object({
  chainId: Type.Optional(Type.Number({ description: "Chain id (defaults to configured default)" })),
  to: Type.String({ description: "Contract address (0x...)" }),
  data: Type.String({ description: "Calldata hex (0x...). Use wallet_encodeCall to build this." }),
  from: Type.Optional(Type.String({ description: "Caller address override (for msg.sender-dependent calls)" })),
});

const walletEncodeCallSchema = Type.Object({
  functionSignature: Type.String({
    description:
      'Solidity function signature, e.g. "transfer(address,uint256)" or "swap(address,address,uint256,uint256,uint256)"',
  }),
  args: Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean()]), {
    description:
      "Ordered arguments matching the function signature. Addresses as hex strings, uint/int as decimal strings, bool as true/false.",
  }),
});

const walletChainsSchema = Type.Object({});

const walletHistorySchema = Type.Object({
  walletId: Type.Optional(Type.String({ description: "Filter by wallet id" })),
  chainId: Type.Optional(Type.Number({ description: "Filter by chain id" })),
  action: Type.Optional(
    Type.String({
      description:
        "Filter by action type (e.g. send_requested, send_approved, send_failed, send_rejected, erc20_approve_requested, erc20_transfer_requested, contract_call_requested, wallet_created, wallet_imported)",
    }),
  ),
  limit: Type.Optional(Type.Number({ description: "Max entries to return (default 50)" })),
});

const walletSendTransactionSchema = Type.Object({
  walletId: Type.Optional(Type.String({ description: "Wallet id override" })),
  transactionRequest: Type.Object(
    {
      to: Type.String({ description: "Contract/recipient address (0x...)" }),
      data: Type.Optional(Type.String({ description: "Calldata hex (0x...)" })),
      value: Type.Optional(
        Type.Union([Type.String(), Type.Number()], {
          description: "ETH value -- accepts hex (0x...) or decimal wei string",
        }),
      ),
      chainId: Type.Optional(
        Type.Union([Type.Number(), Type.String()], { description: "Chain id (number or hex)" }),
      ),
      gasLimit: Type.Optional(
        Type.Union([Type.String(), Type.Number()], { description: "Gas limit (hex or decimal)" }),
      ),
      gasPrice: Type.Optional(
        Type.Union([Type.String(), Type.Number()], { description: "Legacy gas price (hex or decimal)" }),
      ),
      maxFeePerGas: Type.Optional(
        Type.Union([Type.String(), Type.Number()], { description: "EIP-1559 max fee (hex or decimal)" }),
      ),
      maxPriorityFeePerGas: Type.Optional(
        Type.Union([Type.String(), Type.Number()], { description: "EIP-1559 priority fee (hex or decimal)" }),
      ),
      nonce: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Nonce" })),
      from: Type.Optional(Type.String({ description: "Sender address (informational, wallet address is used)" })),
    },
    {
      description:
        "Raw transaction request object -- pass the transactionRequest from LI.FI /quote, 1inch, or any protocol API directly. Hex values are auto-converted.",
    },
  ),
});

/* ------------------------------------------------------------------ */
/*  Well-known chain names (for wallet_chains)                        */
/* ------------------------------------------------------------------ */

const WELL_KNOWN_CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum Mainnet",
  11155111: "Sepolia",
  10: "Optimism",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum One",
  56: "BNB Smart Chain",
  43114: "Avalanche C-Chain",
  250: "Fantom Opera",
  324: "zkSync Era",
  59144: "Linea",
  534352: "Scroll",
  81457: "Blast",
};

/* ------------------------------------------------------------------ */
/*  Plugin                                                            */
/* ------------------------------------------------------------------ */

const walletPlugin = {
  id: "openclast-wallet",
  name: "Openclast Wallet",
  description: "Native custodial EVM wallet with OS keychain + approval flow.",
  configSchema: walletPluginConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = walletPluginConfigSchema.parse(api.pluginConfig);
    const serviceCache = new Map<string, WalletService>();

    const chains = resolveWalletChains(config);
    const defaultChainId = resolveDefaultChainId(config);
    const limits = config.wallets?.defaults?.spending;
    const notify = config.wallets?.notify;

    async function getServiceForContext(ctx: ToolContext): Promise<WalletService> {
      const peerId = extractPeerId(ctx.sessionKey);
      const cached = serviceCache.get(peerId);
      if (cached) return cached;
      const stateDir = resolveStateDirForPeer(peerId);
      const keychainAdapter =
        process.platform === "darwin"
          ? undefined
          : createEncryptedFileKeychainAdapter(stateDir);
      const chainsResolved =
        Object.keys(chains).length > 0
          ? chains
          : {
              [SEPOLIA_CHAIN_ID]: {
                chainId: SEPOLIA_CHAIN_ID,
                rpcUrl: "https://rpc.sepolia.org",
              },
            };
      const svc = createWalletService({
        stateDir,
        chains: chainsResolved,
        defaultChainId,
        limits,
        notify,
        interactWithUnverifiedContracts: config.wallets?.interactWithUnverifiedContracts,
        verifiedTokenAddresses: config.wallets?.defaults?.verifiedTokenAddresses,
        verifiedContractAddresses: config.wallets?.defaults?.verifiedContractAddresses,
        keychainAdapter,
      });
      if (config.wallets?.autoCreateOnStartup === true) {
        await svc.ensureDefaultWallet();
      }
      serviceCache.set(peerId, svc);
      return svc;
    }

    const withErrors =
      (handler: (params: Record<string, unknown>) => Promise<unknown>) =>
      async (_toolCallId: string, params: Record<string, unknown>) => {
        try {
          return jsonResult(await handler(params));
        } catch (error) {
          return jsonResult({ error: error instanceof Error ? error.message : String(error) });
        }
      };

    /* ---- wallet_address ---- */
    api.registerTool((ctx: ToolContext) => ({
      name: "wallet_address",
      label: "Wallet Address",
      description: "Get the default wallet address (or an explicit walletId).",
      parameters: walletAddressSchema,
      execute: withErrors(async (params) => {
        const svc = await getServiceForContext(ctx);
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
    }));

    /* ---- wallet_balance ---- */
    api.registerTool((ctx: ToolContext) => ({
      name: "wallet_balance",
      label: "Wallet Balance",
      description:
        "Fetch native balance and optional ERC20 balances. Use `allChains: true` to get balances across all configured chains. Use `tokenAddress` to query any arbitrary ERC20.",
      parameters: walletBalanceSchema,
      execute: withErrors(async (params) => {
        const svc = await getServiceForContext(ctx);
        const walletId = typeof params.walletId === "string" ? params.walletId : undefined;
        const address = await svc.getAddress(walletId);
        if (!address) {
          throw new Error("No wallet address available.");
        }

        const allChains = params.allChains === true;
        const includeTokens = params.includeTokens === true;
        const arbitraryToken =
          typeof params.tokenAddress === "string" ? params.tokenAddress.trim() : undefined;

        if (allChains) {
          const chains = resolveWalletChains(config);
          const chainIds = Object.keys(chains).map(Number).filter(Number.isFinite);
          const results: Array<Record<string, unknown>> = [];
          for (const cid of chainIds) {
            const chainConfig = resolveWalletChainConfigForBalance(config, cid);
            if (!chainConfig) continue;
            const rpc = createRpcClient(chainConfig.rpcUrl, cid);
            const balance = await rpc.getBalance(address);
            const tokens = includeTokens
              ? await getTokenBalances(rpc.publicClient, cid, address)
              : [];
            results.push({
              chainId: cid,
              chainName: WELL_KNOWN_CHAIN_NAMES[cid] ?? `Chain ${cid}`,
              balanceWei: balance.toString(),
              tokens,
              explorerUrl: getBlockExplorerAddressUrl(config, cid, address),
            });
          }
          return { address, chains: results };
        }

        const chainId =
          typeof params.chainId === "number" ? params.chainId : resolveDefaultChainId(config);
        const chainConfig = resolveWalletChainConfigForBalance(config, chainId);
        if (!chainConfig) {
          throw new Error(`Chain ${chainId} not configured and no public RPC available.`);
        }
        const rpc = createRpcClient(chainConfig.rpcUrl, chainId);
        const balance = await rpc.getBalance(address);
        const tokens = includeTokens
          ? await getTokenBalances(rpc.publicClient, chainId, address)
          : [];

        // Query arbitrary token balance if provided
        let arbitraryTokenBalance: Record<string, unknown> | undefined;
        if (arbitraryToken && arbitraryToken.startsWith("0x") && arbitraryToken.length === 42) {
          try {
            const { parseAbi } = await import("viem");
            const abi = parseAbi([
              "function balanceOf(address account) view returns (uint256)",
              "function symbol() view returns (string)",
              "function decimals() view returns (uint8)",
            ]);
            const bal = await rpc.publicClient.readContract({
              address: arbitraryToken as `0x${string}`,
              abi,
              functionName: "balanceOf",
              args: [address as `0x${string}`],
            });
            let symbol = "UNKNOWN";
            let decimals = 18;
            try {
              symbol = (await rpc.publicClient.readContract({
                address: arbitraryToken as `0x${string}`,
                abi,
                functionName: "symbol",
              })) as string;
              decimals = (await rpc.publicClient.readContract({
                address: arbitraryToken as `0x${string}`,
                abi,
                functionName: "decimals",
              })) as number;
            } catch {
              // some tokens don't implement symbol/decimals
            }
            arbitraryTokenBalance = {
              tokenAddress: arbitraryToken,
              symbol,
              decimals,
              balanceWei: (bal as bigint).toString(),
            };
          } catch {
            arbitraryTokenBalance = {
              tokenAddress: arbitraryToken,
              error: "Failed to read token balance",
            };
          }
        }

        return {
          address,
          chainId,
          balanceWei: balance.toString(),
          tokens,
          ...(arbitraryTokenBalance ? { queriedToken: arbitraryTokenBalance } : {}),
          explorerUrl: getBlockExplorerAddressUrl(config, chainId, address),
        };
      }),
    }));

    /* ---- wallet_create ---- */
    api.registerTool((ctx: ToolContext) => ({
      name: "wallet_create",
      label: "Wallet Create",
      description: "Create a new wallet (address only; keys are never exposed).",
      parameters: walletCreateSchema,
      execute: withErrors(async () => {
        const svc = await getServiceForContext(ctx);
        const meta = await svc.createWallet();
        return {
          walletId: meta.walletId,
          address: meta.address,
          type: meta.type,
          createdAt: meta.createdAt,
        };
      }),
    }));

    /* ---- wallet_list ---- */
    api.registerTool((ctx: ToolContext) => ({
      name: "wallet_list",
      label: "Wallet List",
      description: "List known wallets and the current default wallet.",
      parameters: walletListSchema,
      execute: withErrors(async () => {
        const svc = await getServiceForContext(ctx);
        const { wallets, defaultWalletId } = await svc.listWallets();
        return {
          defaultWalletId,
          wallets: wallets.map((wallet) => ({
            ...wallet,
            isDefault: wallet.walletId === defaultWalletId,
          })),
        };
      }),
    }));

    /* ---- wallet_setDefault ---- */
    api.registerTool((ctx: ToolContext) => ({
      name: "wallet_setDefault",
      label: "Wallet Set Default",
      description: "Set the default wallet by id.",
      parameters: walletSetDefaultSchema,
      execute: withErrors(async (params) => {
        const svc = await getServiceForContext(ctx);
        const walletId = typeof params.walletId === "string" ? params.walletId : "";
        if (!walletId) {
          throw new Error("walletId is required");
        }
        const meta = await svc.setDefaultWallet(walletId);
        return {
          walletId: meta.walletId,
          address: meta.address,
          type: meta.type,
          createdAt: meta.createdAt,
        };
      }),
    }));

    /* ---- wallet_send (with human-readable amounts) ---- */
    api.registerTool((ctx: ToolContext) => ({
      name: "wallet_send",
      label: "Wallet Send",
      description:
        'Create a pending native send transaction. IMPORTANT: If the user specifies a chain (e.g. "on Base", "on Polygon"), you MUST pass the corresponding chainId (Base=8453, Polygon=137, Arbitrum=42161, Ethereum=1, Sepolia=11155111). Supports human-readable amounts: use `amount` + `unit` (e.g. amount:"0.5", unit:"ether") OR raw `valueWei`.',
      parameters: walletSendSchema,
      execute: withErrors(async (params) => {
        const svc = await getServiceForContext(ctx);
        const rawTo = params.to;
        if (typeof rawTo !== "string" || !rawTo.trim()) {
          throw new Error(`Missing or invalid 'to' parameter (received type=${typeof rawTo}, value=${JSON.stringify(rawTo)})`);
        }
        const to = rawTo;
        const valueWei = parseHumanAmount(params, "valueWei");
        if (!valueWei) throw new Error("Either `valueWei` or `amount` is required");
        const chainId = typeof params.chainId === "number" ? params.chainId : undefined;
        const walletId = typeof params.walletId === "string" ? params.walletId : undefined;
        const result = await svc.requestSend({ walletId, chainId, to, valueWei });
        return { txId: result.txId, pending: result.pending };
      }),
    }));

    /* ---- wallet_erc20_approve (with human-readable amounts) ---- */
    api.registerTool((ctx: ToolContext) => ({
      name: "wallet_erc20_approve",
      label: "Wallet ERC20 Approve",
      description:
        'Create a pending ERC20 approve transaction. Supports human-readable amounts: use `amount` + `decimals` (e.g. amount:"100", decimals:6 for USDC) OR raw `amountWei`.',
      parameters: walletErc20ApproveSchema,
      execute: withErrors(async (params) => {
        const svc = await getServiceForContext(ctx);
        const tokenAddress = typeof params.tokenAddress === "string" ? params.tokenAddress : "";
        const spender = typeof params.spender === "string" ? params.spender : "";
        const amountWei = parseHumanAmount(params, "amountWei");
        if (!amountWei) throw new Error("Either `amountWei` or `amount` is required");
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
    }));

    /* ---- wallet_erc20_transfer (with human-readable amounts) ---- */
    api.registerTool((ctx: ToolContext) => ({
      name: "wallet_erc20_transfer",
      label: "Wallet ERC20 Transfer",
      description:
        'Create a pending ERC20 transfer transaction. Supports human-readable amounts: use `amount` + `decimals` (e.g. amount:"50", decimals:6 for USDC) OR raw `amountWei`.',
      parameters: walletErc20TransferSchema,
      execute: withErrors(async (params) => {
        const svc = await getServiceForContext(ctx);
        const tokenAddress = typeof params.tokenAddress === "string" ? params.tokenAddress : "";
        const to = typeof params.to === "string" ? params.to : "";
        const amountWei = parseHumanAmount(params, "amountWei");
        if (!amountWei) throw new Error("Either `amountWei` or `amount` is required");
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
    }));

    /* ---- wallet_contract_call (simplified, with human-readable amounts) ---- */
    api.registerTool((ctx: ToolContext) => ({
      name: "wallet_contract_call",
      label: "Wallet Contract Call",
      description:
        'Create a pending contract call transaction. Use wallet_encodeCall to build the `data` param. Supports human-readable ETH value: use `amount` + `unit` OR raw `valueWei`.',
      parameters: walletContractCallSchema,
      execute: withErrors(async (params) => {
        const svc = await getServiceForContext(ctx);
        const to = typeof params.to === "string" ? params.to : "";
        const data = typeof params.data === "string" ? params.data : "";
        const valueWei = parseHumanAmount(params, "valueWei");
        const gasLimit =
          typeof params.gasLimit === "string" ? params.gasLimit : undefined;
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
          nonce,
        });
        return { txId: result.txId, pending: result.pending };
      }),
    }));

    /* ---- wallet_txStatus ---- */
    api.registerTool((ctx: ToolContext) => ({
      name: "wallet_txStatus",
      label: "Wallet Transaction Status",
      description: "Get the status of a pending transaction (pending=awaiting approval).",
      parameters: walletTxStatusSchema,
      execute: withErrors(async (params) => {
        const svc = await getServiceForContext(ctx);
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
    }));

    /* ---- wallet_approve ---- */
    api.registerTool((ctx: ToolContext) => ({
      name: "wallet_approve",
      label: "Wallet Approve Transaction",
      description: "Approve and broadcast a pending transaction.",
      parameters: walletApproveSchema,
      execute: withErrors(async (params) => {
        const svc = await getServiceForContext(ctx);
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
    }));

    /* ---- wallet_reject ---- */
    api.registerTool((ctx: ToolContext) => ({
      name: "wallet_reject",
      label: "Wallet Reject Transaction",
      description: "Reject/cancel a pending transaction (marks it as rejected, never broadcasts).",
      parameters: walletRejectSchema,
      execute: withErrors(async (params) => {
        const svc = await getServiceForContext(ctx);
        const txId = typeof params.txId === "string" ? params.txId : "";
        return svc.rejectTx(txId);
      }),
    }));

    /* ---- wallet_listPending ---- */
    api.registerTool((ctx: ToolContext) => ({
      name: "wallet_listPending",
      label: "Wallet List Pending",
      description:
        "List all pending transactions awaiting approval. Returns only transactions with status 'pending'.",
      parameters: walletListPendingSchema,
      execute: withErrors(async () => {
        const svc = await getServiceForContext(ctx);
        const pending = await svc.listPending();
        return {
          count: pending.length,
          pending,
        };
      }),
    }));

    /* ---- wallet_readContract (read-only eth_call) ---- */
    api.registerTool((ctx: ToolContext) => ({
      name: "wallet_readContract",
      label: "Wallet Read Contract",
      description:
        "Perform a read-only contract call (eth_call). No transaction, no approval needed. Use wallet_encodeCall to build `data`. Returns raw hex result.",
      parameters: walletReadContractSchema,
      execute: withErrors(async (params) => {
        const to = typeof params.to === "string" ? params.to.trim() : "";
        if (!to.startsWith("0x") || to.length !== 42) throw new Error("Invalid contract address");
        const data = typeof params.data === "string" ? params.data.trim() : "";
        if (!data.startsWith("0x")) throw new Error("data must be hex (0x...)");
        const from = typeof params.from === "string" ? params.from.trim() : undefined;
        const chainId =
          typeof params.chainId === "number" ? params.chainId : resolveDefaultChainId(config);
        const chainConfig = resolveWalletChainConfigForBalance(config, chainId);
        if (!chainConfig) {
          throw new Error(`Chain ${chainId} not configured and no public RPC available.`);
        }
        const rpc = createRpcClient(chainConfig.rpcUrl, chainId);
        const result = await rpc.publicClient.call({
          to: to as `0x${string}`,
          data: data as `0x${string}`,
          ...(from ? { account: from as `0x${string}` } : {}),
        });
        return {
          chainId,
          to,
          result: result.data ?? "0x",
        };
      }),
    }));

    /* ---- wallet_encodeCall (ABI encoding helper) ---- */
    api.registerTool((ctx: ToolContext) => ({
      name: "wallet_encodeCall",
      label: "Wallet Encode Call",
      description:
        'Encode calldata for a contract function. Provide a Solidity function signature and ordered args. Returns hex calldata for use with wallet_contract_call or wallet_readContract. Example: functionSignature="transfer(address,uint256)", args=["0xRecipient","1000000"].',
      parameters: walletEncodeCallSchema,
      execute: withErrors(async (params) => {
        const sig = typeof params.functionSignature === "string" ? params.functionSignature.trim() : "";
        if (!sig) throw new Error("functionSignature is required");
        const args = Array.isArray(params.args) ? params.args : [];

        const viem = await import("viem");

        // Build a minimal ABI from the signature
        // Wrap it as "function <sig> returns ()" so parseAbi accepts it
        const abiStr = sig.startsWith("function ") ? sig : `function ${sig}`;
        const abi = viem.parseAbi([abiStr]);
        // Extract function name from signature
        const fnName = sig.replace(/^function\s+/, "").split("(")[0].trim();

        // Coerce args: addresses stay as strings, numbers as bigints for uint
        const coercedArgs = args.map((arg) => {
          if (typeof arg === "boolean") return arg;
          if (typeof arg === "string") {
            if (arg.startsWith("0x")) return arg;
            if (/^-?\d+$/.test(arg)) return BigInt(arg);
            return arg;
          }
          if (typeof arg === "number") return BigInt(arg);
          return arg;
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime ABI from user input
        const encoded = viem.encodeFunctionData({
          abi: abi as any,
          functionName: fnName as any,
          args: coercedArgs as any,
        } as any);

        return { data: encoded, functionSignature: sig, args };
      }),
    }));

    /* ---- wallet_chains (config introspection) ---- */
    api.registerTool((ctx: ToolContext) => ({
      name: "wallet_chains",
      label: "Wallet Chains",
      description:
        "List all configured chains with their IDs, names, RPC URLs, and block explorer URLs. Use this to discover available chains before sending transactions or checking balances.",
      parameters: walletChainsSchema,
      execute: withErrors(async () => {
        const chains = resolveWalletChains(config);
        const defaultChainId = resolveDefaultChainId(config);
        const entries = Object.entries(chains).map(([idStr, chain]) => {
          const id = Number(idStr);
          return {
            chainId: id,
            name: WELL_KNOWN_CHAIN_NAMES[id] ?? `Chain ${id}`,
            rpcUrl: chain.rpcUrl,
            blockExplorerUrl: chain.blockExplorerUrl ?? undefined,
            isDefault: id === defaultChainId,
          };
        });
        return {
          defaultChainId,
          chains: entries,
        };
      }),
    }));

    /* ---- wallet_history (audit log query) ---- */
    api.registerTool((ctx: ToolContext) => ({
      name: "wallet_history",
      label: "Wallet History",
      description:
        "Query wallet transaction history from the audit log. Returns recent entries (most recent first). Filter by walletId, chainId, or action type.",
      parameters: walletHistorySchema,
      execute: withErrors(async (params) => {
        const svc = await getServiceForContext(ctx);
        const filter: Record<string, unknown> = {};
        if (typeof params.walletId === "string") filter.walletId = params.walletId;
        if (typeof params.chainId === "number") filter.chainId = params.chainId;
        if (typeof params.action === "string") filter.action = params.action;
        if (typeof params.limit === "number") filter.limit = params.limit;
        const entries = await svc.queryHistory(filter as Parameters<typeof svc.queryHistory>[0]);
        return {
          count: entries.length,
          entries,
        };
      }),
    }));

    /* ---- wallet_sendTransaction (raw tx request passthrough) ---- */
    api.registerTool((ctx: ToolContext) => ({
      name: "wallet_sendTransaction",
      label: "Wallet Send Transaction",
      description:
        "Create a pending transaction from a raw transactionRequest object (the kind returned by LI.FI /quote, 1inch, CoW Protocol, etc). " +
        "Pass the transactionRequest object directly -- hex values for value/gasLimit/gasPrice are auto-converted. " +
        "The transaction still goes through the approval flow.",
      parameters: walletSendTransactionSchema,
      execute: withErrors(async (params) => {
        const svc = await getServiceForContext(ctx);
        const txReq = isObject(params.transactionRequest)
          ? params.transactionRequest
          : undefined;
        if (!txReq) throw new Error("transactionRequest object is required");

        const to = typeof txReq.to === "string" ? txReq.to.trim() : "";
        if (!to.startsWith("0x") || to.length !== 42) throw new Error("Invalid to address in transactionRequest");

        const data = typeof txReq.data === "string" ? txReq.data.trim() : undefined;
        const valueWei = hexOrDecToWei(txReq.value);
        const gasLimit = hexOrDecToWei(txReq.gasLimit);
        const gasPrice = hexOrDecToWei(txReq.gasPrice);
        const maxFeePerGas = hexOrDecToWei(txReq.maxFeePerGas);
        const maxPriorityFeePerGas = hexOrDecToWei(txReq.maxPriorityFeePerGas);
        const chainId = readChainId(txReq.chainId) ??
          (typeof params.chainId === "number" ? params.chainId : undefined);
        const walletId = typeof params.walletId === "string" ? params.walletId : undefined;

        let nonce: number | undefined;
        if (typeof txReq.nonce === "number") {
          nonce = txReq.nonce;
        } else if (typeof txReq.nonce === "string") {
          const parsed = txReq.nonce.startsWith("0x")
            ? Number.parseInt(txReq.nonce, 16)
            : Number.parseInt(txReq.nonce, 10);
          if (Number.isFinite(parsed)) nonce = parsed;
        }

        const result = await svc.requestContractCall({
          walletId,
          chainId,
          to,
          valueWei,
          data: data || "0x",
          gasLimit,
          gasPrice,
          maxFeePerGas,
          maxPriorityFeePerGas,
          nonce,
        });
        return { txId: result.txId, pending: result.pending };
      }),
    }));

    /* ---- background service ---- */
    api.registerService({
      id: "openclast-wallet",
      start: async () => {
        /* Per-user wallets are created on first getServiceForContext when autoCreateOnStartup is true. */
      },
      stop: async () => {
        serviceCache.clear();
      },
    });
  },
};

export default walletPlugin;
