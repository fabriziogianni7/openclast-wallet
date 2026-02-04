# Openclast Wallet

Native custodial EVM wallet for [openclaw](https://openclaw.ai/): OS keychain (macOS), configurable chains, notify-and-approve flow. Built with [viem](https://viem.sh).


## OpenClaw plugin install

Install the plugin on openclaw:

```bash
openclaw plugins install openclast-wallet
```

For updating the plugin:

```bash
openclaw plugins update openclast-wallet
```

Then add config under `plugins.entries.openclast-wallet.config` and restart the Gateway:

Point the plugin at an external config file (the plugin will read the JSON at startup):

```json
{
  "plugins": {
    "entries": {
      "openclast-wallet": {
        "enabled": true,
        "config": {
          "configPath": "/absolute/path/to/wallet-config.json"
        }
      }
    }
  }
}
```

This is how the config file looks like:

```json
{
  "wallets": {
    "autoCreateOnStartup": true,
    "chains": {
      "1": {
        "rpcUrl": "https://eth.llamarpc.com",
        "blockExplorerUrl": "https://etherscan.io"
      },
     "42161": {
        "rpcUrl": "https://arb1.arbitrum.io/rpc",
        "blockExplorerUrl": "https://arbiscan.io"
      }
     // other chain confif
    },
    "defaults": {
      "spending": {
        "limitPerTx": "1000000000000000000",
        "dailyLimit": "5000000000000000000"
      }
    },
    "notify": { "primaryChannel": "telegram" }
  }
}
// see other config options below
```

Tools exposed by the plugin:

- `wallet_address`
- `wallet_balance`
- `wallet_create`
- `wallet_list`
- `wallet_send`
- `wallet_txStatus`
- `wallet_approve`
- `wallet_setDefault`
- `wallet_erc20_approve`
- `wallet_erc20_transfer`
- `wallet_contract_call`

## Usage

### CLI

Initialize a wallet from a JSON config you create (e.g. `wallet-config.json`). A starter `wallet-config.json` ships with the package.

```bash
openclast-wallet init --config ./wallet-config.json

# create a starter config in the current folder
openclast-wallet init

# install agent skill into ./skills/openclast-wallet
openclast-wallet install-skill

# create a new wallet entry (defaults to ./wallet-config.json if --config omitted)
openclast-wallet create --config ./wallet-config.json

# list known wallets (marks default)
openclast-wallet list --config ./wallet-config.json

# set a default wallet by id
openclast-wallet set-default <walletId> --config ./wallet-config.json

# export private key (requires confirmation + env gate; defaults to ./wallet-config.json if --config omitted)
MOLTBOT_ALLOW_WALLET_EXPORT=1 openclast-wallet export --config ./wallet-config.json --yes

# restore from private key (defaults to ./wallet-config.json if --config omitted)
openclast-wallet restore --config ./wallet-config.json --private-key 0x...

# restore from mnemonic (defaults to ./wallet-config.json if --config omitted)
openclast-wallet restore --config ./wallet-config.json --mnemonic "word1 word2 ... word12"
# or
openclast-wallet restore --config ./wallet-config.json --mnemonic-file ./seed.txt --account-index 0
```

### State directory

By default the package uses `resolveStateDir()` which reads `MOLTBOT_STATE_DIR` or `CLAWDBOT_STATE_DIR`, or falls back to `~/.moltbot` / `~/.clawdbot`. Wallets and pending tx state live under `<stateDir>/wallets/`.

### Config shape

Use `WalletIntegrationConfig` (compatible with a `wallets` slice of a larger config):

```ts
import {
  createWalletServiceFromConfig,
  resolveWalletChains,
  type WalletIntegrationConfig,
} from "openclast-wallet";

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

### Config settings reference

| Path | Type | Default | Description |
| --- | --- | --- | --- |
| `wallets.autoCreateOnStartup` | boolean | `true` (in wizard) | Auto-create a wallet on startup if none exists. |
| `wallets.interactWithUnverifiedContracts` | boolean | `true` | Allow contract calls to unverified addresses when `false` requires verified allowlists. |
| `wallets.chains` | object | `{}` | Map of chain IDs or names to RPC and explorer settings. |
| `wallets.chains.<chainId>.rpcUrl` | string | `""` | RPC endpoint for the chain. Required for writes. |
| `wallets.chains.<chainId>.blockExplorerUrl` | string | `""` | Base explorer URL for tx/address links. |
| `wallets.defaults.spending.mode` | `"notify" \| "auto"` | `"notify"` | Approval mode: `notify` creates pending tx, `auto` sends immediately. |
| `wallets.defaults.spending.limitPerTx` | string (wei) | `""` | Per-transaction max (wei). Empty disables. |
| `wallets.defaults.spending.dailyLimit` | string (wei) | `""` | Daily spend max (wei). Empty disables. |
| `wallets.defaults.spending.allowedChains` | number[] | `[]` | Restrict sends/calls to specific chain IDs. |
| `wallets.defaults.spending.allowedRecipients` | string[] | `[]` | Restrict sends/calls to specific recipient addresses. |
| `wallets.defaults.spending.notifyChannels` | string[] | `[]` | Channels to notify for approvals (if applicable). |
| `wallets.defaults.verifiedTokenAddresses` | string[] | `[]` | ERC20 allowlist when unverified contracts are blocked. |
| `wallets.defaults.verifiedContractAddresses` | string[] | `[]` | Contract allowlist when unverified contracts are blocked. |
| `wallets.notify.primaryChannel` | string | `""` | Primary notify channel for approvals. |

Notes:
- Chain keys may be numeric strings (e.g. `"8453"`) or aliases like `"sepolia"`.
- Read-only balance queries can use well-known public RPCs even if a chain is not configured.
- Addresses are chain-agnostic; chainId only selects RPC/explorer for the request.

### Important Note

On **macOS**, private keys are stored in the system Keychain. On other platforms the keychain adapter is a stub (create/import throw; getPrivateKey returns null).
This is still under development so BE CAREFUL AND USE IT IN PRODUCTION AT YOUR OWN RISK

### Agent skill

The package ships an agent skill at `skills/openclast-wallet/SKILL.md`. It is copied to `./skills/openclast-wallet` automatically on install, or you can run:

```bash
openclast-wallet install-skill
```

## License

MIT
