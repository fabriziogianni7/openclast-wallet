/**
 * Derive private key from BIP-39 mnemonic (viem mnemonicToAccount, path m/44'/60'/0'/0/<accountIndex>).
 */

import { mnemonicToAccount } from "viem/accounts";

export function mnemonicToPrivateKeyHex(mnemonic: string, accountIndex = 0): string {
  const account = mnemonicToAccount(mnemonic.trim(), { addressIndex: accountIndex });
  const hdKey = account.getHdKey();
  const bytes = hdKey.privateKey;
  if (!bytes || bytes.length !== 32) {
    throw new Error("Failed to derive private key from mnemonic");
  }
  const hex = Buffer.from(bytes).toString("hex");
  return "0x" + hex;
}
