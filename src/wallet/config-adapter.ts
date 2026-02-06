/**
 * Minimal config type and state-dir resolution for standalone package use.
 * Compatible with the wallets slice of MoltbotConfig.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type WalletsChainConfig = {
  rpcUrl?: string;
  blockExplorerUrl?: string;
};

export type WalletIntegrationConfig = {
  wallets?: {
    autoCreateOnStartup?: boolean;
    interactWithUnverifiedContracts?: boolean;
    defaults?: {
      spending?: {
        mode?: "notify" | "auto";
        limitPerTx?: string;
        dailyLimit?: string;
        allowedChains?: number[];
        allowedRecipients?: string[];
        notifyChannels?: string[];
      };
      verifiedTokenAddresses?: string[];
      verifiedContractAddresses?: string[];
    };
    chains?: {
      sepolia?: WalletsChainConfig;
      [chainId: string]: WalletsChainConfig | undefined;
    };
    notify?: {
      primaryChannel?: string;
    };
  };
};

const NEW_STATE_DIRNAME = ".moltbot";
const LEGACY_STATE_DIRNAME = ".clawdbot";

function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("~")) {
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}

/**
 * State directory for mutable data. Uses MOLTBOT_STATE_DIR or CLAWDBOT_STATE_DIR if set,
 * otherwise ~/.moltbot if it exists, else ~/.clawdbot.
 */
export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
  cwd: string = process.cwd(),
): string {
  const override = env.MOLTBOT_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (override) return resolveUserPath(override);
  const home = homedir();
  if (!home || !fs.existsSync(home)) {
    return path.join(cwd, NEW_STATE_DIRNAME);
  }
  const legacyDir = path.join(home, LEGACY_STATE_DIRNAME);
  const newDir = path.join(home, NEW_STATE_DIRNAME);
  const hasLegacy = fs.existsSync(legacyDir);
  const hasNew = fs.existsSync(newDir);
  if (!hasLegacy && hasNew) return newDir;
  return legacyDir;
}

/**
 * Per-user state directory for multi-tenant isolation (e.g. Telegram bot).
 * Returns <baseStateDir>/users/<peerId>. Use peerId from session key (e.g. Telegram user ID).
 */
export function resolveStateDirForPeer(
  peerId: string,
  baseStateDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = baseStateDir ?? resolveStateDir(env);
  const safe = peerId.replace(/[^0-9a-zA-Z_-]/g, "_").trim() || "default";
  return path.join(base.replace(/\/$/, ""), "users", safe);
}
