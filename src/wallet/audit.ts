/**
 * Append-only audit log for wallet actions.
 */

import fs from "node:fs/promises";
import path from "node:path";

const AUDIT_FILENAME = "audit.jsonl";

export type AuditEntry = {
  at?: string;
  action: string;
  txId?: string;
  walletId?: string;
  chainId?: number;
  from?: string;
  to?: string;
  valueWei?: string;
  txHash?: string;
  error?: string;
  tokenAddress?: string;
  spender?: string;
  amountWei?: string;
};

export type AuditLog = {
  append(entry: AuditEntry): Promise<void>;
};

export function createAuditLog(walletsDir: string): AuditLog {
  const filePath = path.join(walletsDir, AUDIT_FILENAME);

  return {
    async append(entry) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const line = JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n";
      await fs.appendFile(filePath, line);
    },
  };
}
