/**
 * Append-only audit log for wallet actions.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { WalletType } from "./types.js";

const AUDIT_FILENAME = "audit.jsonl";

export type AuditEntry = {
  at?: string;
  action: string;
  txId?: string;
  walletId?: string;
  chainId?: number;
  type?: WalletType;
  from?: string;
  to?: string;
  valueWei?: string;
  txHash?: string;
  error?: string;
  tokenAddress?: string;
  spender?: string;
  amountWei?: string;
};

export type AuditLogFilter = {
  walletId?: string;
  chainId?: number;
  action?: string;
  limit?: number;
};

export type AuditLog = {
  append(entry: AuditEntry): Promise<void>;
  query(filter?: AuditLogFilter): Promise<AuditEntry[]>;
};

export function createAuditLog(walletsDir: string): AuditLog {
  const filePath = path.join(walletsDir, AUDIT_FILENAME);

  return {
    async append(entry) {
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const line = JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n";
      await fs.appendFile(filePath, line, { mode: 0o600 });
    },
    async query(filter) {
      let raw: string;
      try {
        raw = await fs.readFile(filePath, "utf8");
      } catch {
        return [];
      }
      const lines = raw.trim().split("\n").filter(Boolean);
      let entries: AuditEntry[] = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as AuditEntry);
        } catch {
          // skip malformed lines
        }
      }
      if (filter?.walletId) {
        entries = entries.filter((e) => e.walletId === filter.walletId);
      }
      if (filter?.chainId != null) {
        entries = entries.filter((e) => e.chainId === filter.chainId);
      }
      if (filter?.action) {
        entries = entries.filter((e) => e.action === filter.action);
      }
      // Most recent first
      entries.reverse();
      const limit = filter?.limit ?? 50;
      return entries.slice(0, limit);
    },
  };
}
