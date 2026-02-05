/**
 * OS keychain-backed storage for wallet private keys.
 * macOS: security add-generic-password / find-generic-password.
 * Other platforms: stub (no key storage).
 */

import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { privateKeyToAddress } from "./tx-builder.js";

const WALLET_KEYCHAIN_SERVICE = "Moltbot Wallet";
const WALLET_KEYCHAIN_ACCOUNT_PREFIX = "wallet:";

/** Strict hex pattern: 0x followed by exactly 40 hex chars (EVM address). */
const SAFE_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** Strict hex pattern: 0x followed by exactly 64 hex chars (private key). */
const SAFE_PRIVKEY_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Validate that a string is safe to interpolate into a macOS `security` shell command.
 * Rejects anything that is not strictly hex-formatted to prevent shell injection.
 */
function assertSafeShellParam(value: string, label: string): void {
  // Only allow [0-9a-fA-Fx:] -- the characters used by hex addresses and the keychain prefix
  if (!/^[0-9a-fA-Fx:]+$/.test(value)) {
    throw new Error(`${label} contains unsafe characters`);
  }
}

export type KeychainAdapter = {
  createWallet(): { walletId: string; privateKeyHex: string };
  importWallet(privateKeyHex: string): { walletId: string };
  getPrivateKey(walletId: string): string | null;
  deleteWallet(walletId: string): boolean;
};

function generatePrivateKey(): string {
  const bytes = randomBytes(32);
  return "0x" + bytes.toString("hex");
}

function keychainAccount(walletId: string): string {
  assertSafeShellParam(walletId, "walletId");
  return `${WALLET_KEYCHAIN_ACCOUNT_PREFIX}${walletId}`;
}

function darwinSetPassword(service: string, account: string, password: string): void {
  // account is always produced by keychainAccount() which already validated walletId.
  // password (private key) is validated by SAFE_PRIVKEY_RE before reaching here.
  assertSafeShellParam(password, "keychain password");
  try {
    execSync(
      `security add-generic-password -U -s '${service}' -a '${account}' -w '${password}'`,
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch {
    execSync(
      `security delete-generic-password -s '${service}' -a '${account}' 2>/dev/null; security add-generic-password -U -s '${service}' -a '${account}' -w '${password}'`,
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    );
  }
}

function darwinGetPassword(service: string, account: string): string | null {
  try {
    const result = execSync(
      `security find-generic-password -s '${service}' -a '${account}' -w 2>/dev/null`,
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    );
    return result.trim() || null;
  } catch {
    return null;
  }
}

function darwinDeletePassword(service: string, account: string): boolean {
  try {
    execSync(`security delete-generic-password -s '${service}' -a '${account}' 2>/dev/null`, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

export function createKeychainAdapter(platform: NodeJS.Platform = process.platform): KeychainAdapter {
  if (platform === "darwin") {
    return {
      createWallet(): { walletId: string; privateKeyHex: string } {
        const privateKeyHex = generatePrivateKey();
        if (!SAFE_PRIVKEY_RE.test(privateKeyHex)) {
          throw new Error("Generated key failed safety check");
        }
        const walletId = privateKeyToAddress(privateKeyHex);
        if (!SAFE_ADDRESS_RE.test(walletId)) {
          throw new Error("Derived address failed safety check");
        }
        darwinSetPassword(WALLET_KEYCHAIN_SERVICE, keychainAccount(walletId), privateKeyHex);
        return { walletId, privateKeyHex };
      },
      importWallet(privateKeyHex: string): { walletId: string } {
        const normalized = privateKeyHex.replace(/^0x/, "").toLowerCase();
        if (normalized.length !== 64 || !/^[0-9a-f]{64}$/.test(normalized)) {
          throw new Error("Invalid private key: must be 64 hex characters");
        }
        const key = "0x" + normalized;
        const walletId = privateKeyToAddress(key);
        if (!SAFE_ADDRESS_RE.test(walletId)) {
          throw new Error("Derived address failed safety check");
        }
        darwinSetPassword(WALLET_KEYCHAIN_SERVICE, keychainAccount(walletId), key);
        return { walletId };
      },
      getPrivateKey(walletId: string): string | null {
        const raw = darwinGetPassword(WALLET_KEYCHAIN_SERVICE, keychainAccount(walletId));
        if (!raw) return null;
        return raw.startsWith("0x") ? raw : "0x" + raw;
      },
      deleteWallet(walletId: string): boolean {
        return darwinDeletePassword(WALLET_KEYCHAIN_SERVICE, keychainAccount(walletId));
      },
    };
  }

  return {
    createWallet(): { walletId: string; privateKeyHex: string } {
      throw new Error("Wallet keychain is only supported on macOS in this milestone");
    },
    importWallet(): { walletId: string } {
      throw new Error("Wallet keychain is only supported on macOS in this milestone");
    },
    getPrivateKey(): string | null {
      return null;
    },
    deleteWallet(): boolean {
      return false;
    },
  };
}
