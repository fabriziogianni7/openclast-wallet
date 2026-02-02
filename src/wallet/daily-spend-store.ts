/**
 * Persisted daily spend tally for wallet dailyLimit enforcement.
 */

import fs from "node:fs/promises";
import path from "node:path";

export type DailySpendRecord = {
  date: string;
  totalWei: string;
};

const DAILY_SPEND_FILENAME = "daily-spend.json";

function todayUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export type DailySpendStore = {
  getTotalForDate(date: string): Promise<bigint>;
  addSpend(date: string, valueWei: bigint): Promise<void>;
};

export function createDailySpendStore(walletsDir: string): DailySpendStore {
  const filePath = path.join(walletsDir, DAILY_SPEND_FILENAME);

  async function load(): Promise<DailySpendRecord> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const data = JSON.parse(raw) as DailySpendRecord;
      if (typeof data.date === "string" && typeof data.totalWei === "string") {
        return data;
      }
    } catch {
      // ignore
    }
    return { date: "", totalWei: "0" };
  }

  async function save(record: DailySpendRecord): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(record, null, 2));
  }

  return {
    async getTotalForDate(date: string): Promise<bigint> {
      const record = await load();
      if (record.date !== date) return 0n;
      try {
        return BigInt(record.totalWei);
      } catch {
        return 0n;
      }
    },
    async addSpend(date: string, valueWei: bigint): Promise<void> {
      const record = await load();
      const total =
        record.date === date ? BigInt(record.totalWei) + valueWei : valueWei;
      await save({ date, totalWei: total.toString() });
    },
  };
}

export function getTodayUtc(): string {
  return todayUtc();
}
