#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createWalletServiceFromConfig } from "./wallet/index.js";

type CliConfig = Record<string, unknown>;

function printUsage(): void {
  console.log(
    [
      "openclast-wallet",
      "",
      "Usage:",
      "  openclast-wallet setup --config <path>",
      "  openclast-wallet init --config <path>",
      "",
      "Options:",
      "  -c, --config   Path to a JSON config file",
      "  -h, --help     Show help",
    ].join("\n"),
  );
}

function readFlag(args: string[], name: string, alias?: string): string | null {
  const idx = args.findIndex((arg) => arg === name || (alias && arg === alias));
  if (idx === -1) return null;
  const value = args[idx + 1];
  if (!value || value.startsWith("-")) return null;
  return value;
}

async function loadConfig(path: string): Promise<CliConfig> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as CliConfig;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    printUsage();
    return;
  }

  const command = args[0];
  if (command !== "setup" && command !== "init") {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  const configPath = readFlag(args, "--config", "-c");
  if (!configPath) {
    console.error("Missing required --config <path>.");
    printUsage();
    process.exitCode = 1;
    return;
  }

  try {
    const config = (await loadConfig(configPath)) as {
      wallets?: Record<string, unknown>;
    };
    const service = createWalletServiceFromConfig(config);
    if (!service) {
      console.error("Invalid config: unable to initialize wallet service.");
      process.exitCode = 1;
      return;
    }
    await service.ensureDefaultWallet();
    const address = await service.getAddress();
    console.log(`Wallet ready: ${address}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Setup failed: ${message}`);
    process.exitCode = 1;
  }
}

try {
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Setup failed: ${message}`);
  process.exitCode = 1;
}
