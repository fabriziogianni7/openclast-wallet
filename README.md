# Openclast Wallet

Native custodial EVM wallet for [openclaw](https://openclaw.ai/): OS keychain (macOS), configurable chains, notify-and-approve flow. Built with [viem](https://viem.sh).

## Install

```bash
pnpm add openclast-wallet
# or
npm install openclast-wallet
```

## Usage

### Config shape

Use `WalletIntegrationConfig` (compatible with a `wallets` slice of a larger config):

```ts
import {
  createWalletServiceFromConfig,
  resolveWalletChains,
  type WalletIntegrationConfig,
} from "@fabriziogianni7/openclaw-evm-wallet-integration";

const config: WalletIntegrationConfig = {
  wallets: {
    chains: {
      sepolia: { rpcUrl: "https://rpc.sepolia.org" },
      1: { rpcUrl: "https://eth.llamarpc.com", blockExplorerUrl: "https://etherscan.io" },
    },
    defaults: {
      spending: { limitPerTx: "1000000000000000000", dailyLimit: "5000000000000000000" },
    },
    notify: { primaryChannel: "slack" },
  },
};

const service = createWalletServiceFromConfig(config);
if (service) {
  await service.ensureDefaultWallet();
  const address = await service.getAddress();
  // requestSend, approveTx, getPendingTx, etc.
}
```

### State directory

By default the package uses `resolveStateDir()` which reads `MOLTBOT_STATE_DIR` or `CLAWDBOT_STATE_DIR`, or falls back to `~/.moltbot` / `~/.clawdbot`. Wallets and pending tx state live under `<stateDir>/wallets/`.

### API overview

- **createWalletService(config)** — build service from explicit `WalletServiceConfig` (stateDir, chains, defaultChainId, limits, etc.).
- **createWalletServiceFromConfig(cfg)** — build service from `WalletIntegrationConfig`; uses default Sepolia if no chains are set.
- **resolveWalletChains(cfg)**, **resolveDefaultChainId(cfg)**, **resolveWalletChainConfig(cfg, chainId)** — derive chain config from `WalletIntegrationConfig`.
- **resolveWalletChainConfigForBalance(cfg, chainId)** — chain config for read-only use (config + well-known public RPCs).
- **getBlockExplorerTxUrl(cfg, chainId, txHash)**, **getBlockExplorerAddressUrl(cfg, chainId, address)** — block explorer URLs.
- **WalletService** — ensureDefaultWallet, createWallet, importWallet, recoverFromMnemonic, getAddress, getDefaultWalletId, getPrivateKey, requestSend, requestErc20Approve, requestErc20Transfer, requestContractCall, approveTx, getPendingTx, listPending.

### Keychain

On **macOS**, private keys are stored in the system Keychain. On other platforms the keychain adapter is a stub (create/import throw; getPrivateKey returns null).

## License

MIT
