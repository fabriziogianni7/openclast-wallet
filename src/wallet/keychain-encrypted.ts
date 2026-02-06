/**
 * Encrypted file-backed keychain for server/Linux environments.
 * Uses AES-256-GCM with a master key from WALLET_ENCRYPTION_KEY env var.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { privateKeyToAddress } from "./tx-builder.js";
import type { KeychainAdapter } from "./keychain.js";

const SAFE_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SAFE_PRIVKEY_RE = /^0x[0-9a-fA-F]{64}$/;

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SALT_LENGTH = 32;

type EncryptedPayload = {
  iv: string;
  tag: string;
  ciphertext: string;
};

function getMasterKey(): Buffer {
  const raw = process.env.WALLET_ENCRYPTION_KEY?.trim();
  if (!raw || raw.length < 64) {
    throw new Error(
      "WALLET_ENCRYPTION_KEY must be set and at least 64 hex chars (32 bytes) for encrypted keychain",
    );
  }
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("WALLET_ENCRYPTION_KEY must be 64 hex characters");
  }
  return Buffer.from(hex, "hex");
}

function generatePrivateKey(): string {
  const bytes = randomBytes(32);
  return "0x" + bytes.toString("hex");
}

function safeWalletIdFilename(walletId: string): string {
  if (!SAFE_ADDRESS_RE.test(walletId)) {
    throw new Error("Invalid walletId for keychain file");
  }
  return walletId.replace(/^0x/, "").toLowerCase() + ".json";
}

function ensureKeysDir(stateDir: string): string {
  const keysDir = path.join(stateDir.replace(/\/$/, ""), "keys");
  if (!fs.existsSync(keysDir)) {
    fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  }
  return keysDir;
}

function encrypt(plaintext: string, masterKey: Buffer): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv, { authTagLength: TAG_LENGTH });
  const enc = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: enc.toString("base64"),
  };
}

function decrypt(payload: EncryptedPayload, masterKey: Buffer): string {
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const decipher = createDecipheriv(ALGORITHM, masterKey, iv, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}

/**
 * Create a KeychainAdapter that stores private keys encrypted on disk.
 * Requires WALLET_ENCRYPTION_KEY env var (64 hex chars = 32 bytes).
 */
export function createEncryptedFileKeychainAdapter(
  stateDir: string,
): KeychainAdapter {
  const masterKey = getMasterKey();
  const keysDir = ensureKeysDir(stateDir);

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
      const payload = encrypt(privateKeyHex, masterKey);
      const filePath = path.join(keysDir, safeWalletIdFilename(walletId));
      fs.writeFileSync(filePath, JSON.stringify(payload), {
        mode: 0o600,
        encoding: "utf8",
      });
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
      const payload = encrypt(key, masterKey);
      const filePath = path.join(keysDir, safeWalletIdFilename(walletId));
      fs.writeFileSync(filePath, JSON.stringify(payload), {
        mode: 0o600,
        encoding: "utf8",
      });
      return { walletId };
    },

    getPrivateKey(walletId: string): string | null {
      const filePath = path.join(keysDir, safeWalletIdFilename(walletId));
      if (!fs.existsSync(filePath)) return null;
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        const payload = JSON.parse(raw) as EncryptedPayload;
        const dec = decrypt(payload, masterKey);
        return dec.startsWith("0x") ? dec : "0x" + dec;
      } catch {
        return null;
      }
    },

    deleteWallet(walletId: string): boolean {
      const filePath = path.join(keysDir, safeWalletIdFilename(walletId));
      if (!fs.existsSync(filePath)) return true;
      try {
        fs.unlinkSync(filePath);
        return true;
      } catch {
        return false;
      }
    },
  };
}
