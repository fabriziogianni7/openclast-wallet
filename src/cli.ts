#!/usr/bin/env node
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { createKeychainAdapter, createWalletServiceFromConfig } from "./wallet/index.js";

type CliConfig = Record<string, unknown>;

function printUsage(): void {
  console.log(
    [
      "openclast-wallet",
      "",
      "Usage:",
      "  openclast-wallet init [--config <path>]",
      "  openclast-wallet create [--config <path>]",
      "  openclast-wallet list [--config <path>]",
      "  openclast-wallet set-default <walletId> [--config <path>]",
      "  openclast-wallet export [--config <path>] --yes",
      "  openclast-wallet restore [--config <path>] [--private-key <hex> | --private-key-file <path> | --mnemonic <words> | --mnemonic-file <path>] [--account-index <n>]",
      "  openclast-wallet install-skill",
      "",
      "Options:",
      "  -c, --config   Path to a JSON config file",
      "  --yes          Confirm sensitive operation (export)",
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

function hasFlag(args: string[], name: string, alias?: string): boolean {
  return args.includes(name) || (alias ? args.includes(alias) : false);
}

async function loadConfig(path: string): Promise<CliConfig> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as CliConfig;
}

function resolvePackageDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function resolveSkillSourceDir(): string {
  return path.resolve(resolvePackageDir(), "../skills/openclast-wallet");
}

function resolveDefaultConfigPath(): string {
  return path.resolve(process.cwd(), "wallet-config.json");
}

async function writeTemplateConfig(targetPath: string): Promise<void> {
  const templateUrl = new URL("../wallet-config.json", import.meta.url);
  const raw = await readFile(templateUrl, "utf8");
  await writeFile(targetPath, raw, "utf8");
}

async function loadTemplateConfig(): Promise<CliConfig> {
  const templateUrl = new URL("../wallet-config.json", import.meta.url);
  const raw = await readFile(templateUrl, "utf8");
  return JSON.parse(raw) as CliConfig;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirForFile(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
}

type WizardWalletConfig = {
  wallets: {
    autoCreateOnStartup?: boolean;
    chains?: Record<string, { rpcUrl?: string; blockExplorerUrl?: string }>;
    defaults?: { spending?: { mode?: "notify" | "auto"; limitPerTx?: string; dailyLimit?: string } };
    notify?: { primaryChannel?: string };
  };
};

const CHAIN_ALIASES: Record<string, number> = {
  mainnet: 1,
  ethereum: 1,
  eth: 1,
  sepolia: 11155111,
  polygon: 137,
  matic: 137,
  base: 8453,
  arbitrum: 42161,
  arb: 42161,
};

const DEFAULT_CHAIN_CONFIG: Record<number, { rpcUrl?: string; blockExplorerUrl?: string }> = {
  1: { rpcUrl: "https://eth.llamarpc.com", blockExplorerUrl: "https://etherscan.io" },
  11155111: { rpcUrl: "https://rpc.sepolia.org", blockExplorerUrl: "https://sepolia.etherscan.io" },
  137: { rpcUrl: "https://polygon.llamarpc.com", blockExplorerUrl: "https://polygonscan.com" },
  8453: { rpcUrl: "https://mainnet.base.org", blockExplorerUrl: "https://basescan.org" },
  42161: { rpcUrl: "https://arb1.arbitrum.io/rpc", blockExplorerUrl: "https://arbiscan.io" },
};

function normalizeChainToken(token: string): number | null {
  const trimmed = token.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed in CHAIN_ALIASES) return CHAIN_ALIASES[trimmed];
  const asNumber = Number.parseInt(trimmed, 10);
  return Number.isFinite(asNumber) ? asNumber : null;
}

async function promptString(
  rl: ReturnType<typeof createInterface>,
  label: string,
  fallback: string,
): Promise<string> {
  const answer = (await rl.question(`${label} (${fallback}): `)).trim();
  return answer || fallback;
}

async function promptYesNo(
  rl: ReturnType<typeof createInterface>,
  label: string,
  fallback: boolean,
): Promise<boolean> {
  const defaultLabel = fallback ? "y" : "n";
  const answer = (await rl.question(`${label} (y/n, default ${defaultLabel}): `)).trim().toLowerCase();
  if (!answer) return fallback;
  return answer.startsWith("y");
}

async function runConfigWizard(
  targetPath: string,
  template: CliConfig,
): Promise<WizardWalletConfig> {
  const defaults = template as WizardWalletConfig;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const autoCreateDefault = defaults.wallets?.autoCreateOnStartup ?? true;
    const autoCreateOnStartup = await promptYesNo(
      rl,
      "Auto-create wallet on startup",
      autoCreateDefault,
    );

    const chainDefault = "sepolia,1";
    const chainAnswer = await promptString(
      rl,
      "Chains to configure (comma-separated names or ids)",
      chainDefault,
    );
    const chainTokens = chainAnswer.split(",").map((token) => token.trim()).filter(Boolean);
    const chainIds = chainTokens
      .map(normalizeChainToken)
      .filter((value): value is number => value != null);

    const chains: Record<string, { rpcUrl?: string; blockExplorerUrl?: string }> = {};
    for (const chainId of chainIds) {
      const defaultsForChain = DEFAULT_CHAIN_CONFIG[chainId] ?? {};
      const rpcUrl = await promptString(
        rl,
        `RPC URL for chain ${chainId}`,
        defaultsForChain.rpcUrl ?? "",
      );
      const blockExplorerUrl = await promptString(
        rl,
        `Block explorer URL for chain ${chainId}`,
        defaultsForChain.blockExplorerUrl ?? "",
      );
      chains[String(chainId)] = {
        rpcUrl: rpcUrl || undefined,
        blockExplorerUrl: blockExplorerUrl || undefined,
      };
    }

    const spendingDefaults = defaults.wallets?.defaults?.spending ?? {};
    const spendingMode = (await promptString(
      rl,
      "Spending mode (notify/auto)",
      spendingDefaults.mode ?? "notify",
    )) as "notify" | "auto";
    const limitPerTx = await promptString(
      rl,
      "Per-tx limit (wei)",
      spendingDefaults.limitPerTx ?? "1000000000000000000",
    );
    const dailyLimit = await promptString(
      rl,
      "Daily limit (wei)",
      spendingDefaults.dailyLimit ?? "5000000000000000000",
    );

    const notifyDefault = defaults.wallets?.notify?.primaryChannel ?? "telegram";
    const primaryChannel = await promptString(rl, "Notify channel", notifyDefault);

    return {
      wallets: {
        autoCreateOnStartup,
        chains,
        defaults: {
          spending: {
            mode: spendingMode,
            limitPerTx,
            dailyLimit,
          },
        },
        notify: {
          primaryChannel,
        },
      },
    };
  } finally {
    rl.close();
  }
}

async function ensureConfigWithWizard(targetPath: string): Promise<void> {
  if (await fileExists(targetPath)) {
    return;
  }
  await ensureDirForFile(targetPath);
  const template = await loadTemplateConfig();
  console.log(`Config file not found. Creating ${targetPath} via setup wizard...`);
  const wizardConfig = await runConfigWizard(targetPath, template);
  await writeFile(targetPath, JSON.stringify(wizardConfig, null, 2) + "\n", "utf8");
  console.log(`Wrote config to ${targetPath}`);
}

async function copyDir(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(sourceDir, entry.name);
    const dest = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDir(src, dest);
    } else if (entry.isFile()) {
      await copyFile(src, dest);
    }
  }
}

async function installSkill(targetRoot: string): Promise<void> {
  const sourceDir = resolveSkillSourceDir();
  const targetDir = path.join(targetRoot, "skills", "openclast-wallet");
  if (await fileExists(targetDir)) {
    console.log(`Skill already installed at ${targetDir}`);
    return;
  }
  await copyDir(sourceDir, targetDir);
  console.log(`Installed skill to ${targetDir}`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    printUsage();
    return;
  }

  const command = args[0];
  if (
    command !== "init" &&
    command !== "create" &&
    command !== "list" &&
    command !== "set-default" &&
    command !== "export" &&
    command !== "restore" &&
    command !== "install-skill"
  ) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (command === "install-skill") {
    await installSkill(process.cwd());
    return;
  }

  try {
    const configPath = readFlag(args, "--config", "-c");
    if (command === "init") {
      if (configPath && configPath.startsWith("@")) {
        const targetPath = configPath.slice(1) || "wallet-config.json";
        if (await fileExists(targetPath)) {
          console.error(`Config file already exists: ${targetPath}`);
          process.exitCode = 1;
          return;
        }
        await writeTemplateConfig(targetPath);
        console.log(`Wrote starter config to ${targetPath}.`);
        console.log("Customize it, then run:");
        console.log(`  openclast-wallet ${command} --config ${targetPath}`);
        return;
      }

      if (!configPath) {
        const targetPath = "wallet-config.json";
        if (await fileExists(targetPath)) {
          console.error(`Config file already exists: ${targetPath}`);
          process.exitCode = 1;
          return;
        }
        await writeTemplateConfig(targetPath);
        console.log(`Wrote starter config to ${targetPath}.`);
        console.log("Customize it, then run:");
        console.log(`  openclast-wallet ${command} --config ${targetPath}`);
        return;
      }
    }

    const resolvedConfigPath = configPath ?? resolveDefaultConfigPath();
    if (command === "create" || command === "export" || command === "restore") {
      await ensureConfigWithWizard(resolvedConfigPath);
    }
    const config = (await loadConfig(resolvedConfigPath)) as {
      wallets?: Record<string, unknown>;
    };
    const service = createWalletServiceFromConfig(config);
    if (!service) {
      console.error("Invalid config: unable to initialize wallet service.");
      process.exitCode = 1;
      return;
    }
    if (command === "create") {
      const meta = await service.createWallet();
      console.log(`Wallet created: ${meta.address} (${meta.walletId})`);
      return;
    }

    if (command === "list") {
      const { wallets, defaultWalletId } = await service.listWallets();
      if (wallets.length === 0) {
        console.log("No wallets found.");
        return;
      }
      for (const wallet of wallets) {
        const isDefault = wallet.walletId === defaultWalletId;
        const label = `${wallet.address} (${wallet.walletId}) type ${wallet.type}`;
        console.log(`${label}${isDefault ? " [default]" : ""}`);
      }
      return;
    }

    if (command === "set-default") {
      const walletId = args[1];
      if (!walletId || walletId.startsWith("-")) {
        console.error("Usage: openclast-wallet set-default <walletId>");
        process.exitCode = 1;
        return;
      }
      const meta = await service.setDefaultWallet(walletId);
      console.log(`Default wallet set: ${meta.address} (${meta.walletId})`);
      return;
    }

    if (command === "export") {
      const allowExport = process.env.MOLTBOT_ALLOW_WALLET_EXPORT === "1";
      const confirmed = hasFlag(args, "--yes");
      if (!allowExport) {
        console.error("Export disabled. Set MOLTBOT_ALLOW_WALLET_EXPORT=1 to enable.");
        process.exitCode = 1;
        return;
      }
      if (!confirmed) {
        console.error("Export requires confirmation: pass --yes.");
        process.exitCode = 1;
        return;
      }
      const defaultWalletId = await service.getDefaultWalletId();
      if (!defaultWalletId) {
        console.error("No default wallet found.");
        process.exitCode = 1;
        return;
      }
      const keychain = createKeychainAdapter();
      const privateKey = keychain.getPrivateKey(defaultWalletId);
      if (!privateKey) {
        console.error("No private key found for default wallet.");
        process.exitCode = 1;
        return;
      }
      const address = await service.getAddress();
      console.log(`Address: ${address ?? "unknown"}`);
      console.log(`Private key: ${privateKey}`);
      return;
    }

    if (command === "restore") {
      const privateKeyHex = readFlag(args, "--private-key");
      const privateKeyFile = readFlag(args, "--private-key-file");
      const mnemonic = readFlag(args, "--mnemonic");
      const mnemonicFile = readFlag(args, "--mnemonic-file");
      const accountIndexRaw = readFlag(args, "--account-index");
      const accountIndex = accountIndexRaw ? Number.parseInt(accountIndexRaw, 10) : undefined;
      if (accountIndexRaw && !Number.isFinite(accountIndex)) {
        console.error("Invalid --account-index, must be a number.");
        process.exitCode = 1;
        return;
      }
      if (privateKeyHex) {
        console.warn(
          "WARNING: --private-key passes the key as a CLI argument visible in process lists.\n" +
          "         Prefer --private-key-file <path> for safer import.",
        );
      }
      let meta = null as Awaited<ReturnType<typeof service.createWallet>> | null;
      if (privateKeyHex) {
        meta = await service.importWallet(privateKeyHex);
      } else if (privateKeyFile) {
        const keyFromFile = (await readFile(privateKeyFile, "utf8")).trim();
        if (!keyFromFile) {
          console.error("Private key file is empty.");
          process.exitCode = 1;
          return;
        }
        meta = await service.importWallet(keyFromFile);
      } else {
        let mnemonicValue = mnemonic;
        if (!mnemonicValue && mnemonicFile) {
          mnemonicValue = (await readFile(mnemonicFile, "utf8")).trim();
        }
        if (!mnemonicValue) {
          console.error("Restore requires --private-key, --mnemonic, or --mnemonic-file.");
          process.exitCode = 1;
          return;
        }
        meta = await service.recoverFromMnemonic(mnemonicValue, accountIndex);
      }
      console.log(`Wallet restored: ${meta.address} (${meta.walletId})`);
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
