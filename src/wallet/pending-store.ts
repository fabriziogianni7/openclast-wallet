/**
 * Persisted pending transaction approvals under state dir.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { PendingTx } from "./types.js";

export type PendingStore = {
  dir: string;
  load(): Promise<PendingTx[]>;
  save(items: PendingTx[]): Promise<void>;
  add(tx: PendingTx): Promise<void>;
  get(txId: string): Promise<PendingTx | null>;
  update(txId: string, patch: Partial<PendingTx>): Promise<PendingTx | null>;
};

const PENDING_FILENAME = "pending.json";

export function createPendingStore(walletsDir: string): PendingStore {
  const filePath = path.join(walletsDir, PENDING_FILENAME);

  async function load(): Promise<PendingTx[]> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  async function save(items: PendingTx[]): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(filePath, JSON.stringify(items, null, 2), { mode: 0o600 });
  }

  return {
    dir: walletsDir,
    load,
    async save(items) {
      await save(items);
    },
    async add(tx) {
      const items = await load();
      if (items.some((t) => t.txId === tx.txId)) return;
      items.push(tx);
      await save(items);
    },
    async get(txId) {
      const items = await load();
      return items.find((t) => t.txId === txId) ?? null;
    },
    async update(txId, patch) {
      const items = await load();
      const idx = items.findIndex((t) => t.txId === txId);
      if (idx === -1) return null;
      items[idx] = { ...items[idx], ...patch };
      await save(items);
      return items[idx] ?? null;
    },
  };
}
