/**
 * Wallet metadata and default wallet state (no keys) under state dir.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { WalletState } from "./types.js";

const STATE_FILENAME = "state.json";

export type StateStore = {
  dir: string;
  load(): Promise<WalletState>;
  save(state: WalletState): Promise<void>;
};

export function createStateStore(walletsDir: string): StateStore {
  const filePath = path.join(walletsDir, STATE_FILENAME);

  async function load(): Promise<WalletState> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const data = JSON.parse(raw) as WalletState;
      return {
        defaultWalletId: data.defaultWalletId ?? null,
        wallets: data.wallets ?? {},
      };
    } catch {
      return { defaultWalletId: null, wallets: {} };
    }
  }

  async function save(state: WalletState): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(state, null, 2));
  }

  return {
    dir: walletsDir,
    load,
    save,
  };
}
