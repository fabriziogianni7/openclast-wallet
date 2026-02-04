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
  return `${WALLET_KEYCHAIN_ACCOUNT_PREFIX}${walletId}`;
}

function darwinSetPassword(service: string, account: string, password: string): void {
  const escaped = password.replace(/'/g, "'\"'\"'");
  try {
    execSync(
      `security add-generic-password -U -s "${service}" -a "${account}" -w '${escaped}'`,
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch {
    execSync(
      `security delete-generic-password -s "${service}" -a "${account}" 2>/dev/null; security add-generic-password -U -s "${service}" -a "${account}" -w '${escaped}'`,
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    );
  }
}

function darwinGetPassword(service: string, account: string): string | null {
  try {
    const result = execSync(
      `security find-generic-password -s "${service}" -a "${account}" -w 2>/dev/null`,
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    );
    return result.trim() || null;
  } catch {
    return null;
  }
}

function darwinDeletePassword(service: string, account: string): boolean {
  try {
    execSync(`security delete-generic-password -s "${service}" -a "${account}" 2>/dev/null`, {
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
        const walletId = privateKeyToAddress(privateKeyHex);
        darwinSetPassword(WALLET_KEYCHAIN_SERVICE, keychainAccount(walletId), privateKeyHex);
        return { walletId, privateKeyHex };
      },
      importWallet(privateKeyHex: string): { walletId: string } {
        const normalized = privateKeyHex.replace(/^0x/, "").toLowerCase();
        if (normalized.length !== 64) throw new Error("Invalid private key length");
        const walletId = privateKeyToAddress("0x" + normalized);
        darwinSetPassword(WALLET_KEYCHAIN_SERVICE, keychainAccount(walletId), "0x" + normalized);
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
