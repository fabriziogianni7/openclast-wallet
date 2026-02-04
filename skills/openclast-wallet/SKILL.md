---
name: Openclast Wallet
description: Guides the agent in Openclast wallet usage, approvals, and safety rules. Use when users ask about wallet setup, balances, transactions, approvals.
metadata:
  {
    "openclaw":
      {
        "emoji": "💰"
      },
  }
---

# Openclast Wallet Guide

## Quick start

- Use the CLI to bootstrap:
  - `openclast-wallet init` creates `wallet-config.json` in the current folder.
  - `openclast-wallet init --config ./wallet-config.json` initializes the wallet from that file.
- Prefer `wallet-config.json` in the project root and customize chains and limits before use.
- Keep `wallet-config.json` separate from `openclaw.json` (Openclaw config does not accept a top-level `wallets` key).

## Approval flow (mandatory)

All send/approve/contract operations create a **pending transaction** that requires explicit approval.
Always:
1. Create the pending tx (send/erc20/contract call).
2. Ask the user to approve.
3. Only after approval, broadcast and confirm.

If the user asks to “just send,” still require approval unless config is explicitly set to auto mode.

## Key export warning (mandatory)

Never expose private keys by default. If the user asks for export:
- Require explicit confirmation.
- Warn that key export is dangerous and should be protected.
- Use environment gates if available (e.g., `MOLTBOT_ALLOW_WALLET_EXPORT=1`) and explicit CLI confirmation.

If export is not supported in this host, say so and offer safer alternatives.
Wallet creation is safe: `wallet_create` returns address metadata only (no keys).

## Common tasks

### Balance and tokens
- EVM wallet addresses are chain-agnostic; do not ask to switch wallets for a balance check.
- Use the correct chainId for the chain the user mentions.
- If multiple wallets exist and the user does not specify one, use the default wallet.
- If a chain is not configured, read-only balance may still be possible via well-known public RPCs.

### Listing wallets
- Only show wallet addresses in agent when asking about listing wallets, not IDs.

### Sending
- Validate chainId and recipient.
- Respect per-tx and daily limits from config.
- Always provide a block explorer link when a tx is confirmed.

### Chain name → chainId

- Ethereum / Mainnet: `1`
- Sepolia: `11155111`
- Polygon: `137`
- Base: `8453`
- Arbitrum One: `42161`
- Optimism: `10`
- Fantom: `250`
- Avalanche: `43114`
- Binance Smart Chain: `56`

When the user says “balance on Sepolia” or “send on Ethereum,” always map to a chainId and proceed.

## Safety defaults

- Default mode is notify/approval, not auto-send.
- Restrict unverified contracts when possible.
- Never export or display private keys.


## Config rules (apply when present)

- `wallets.defaults.spending.mode`: `"notify"` (default) or `"auto"` (sends without approval).
- `wallets.defaults.spending.limitPerTx`, `dailyLimit`, `allowedChains`, `allowedRecipients`, `notifyChannels`: enforced for send/ERC20/contract calls.
- `wallets.notify.primaryChannel`: where pending approvals are notified.
- `wallets.interactWithUnverifiedContracts`: if `false`, only allow `verifiedTokenAddresses` and `verifiedContractAddresses`.

## Block explorer links (mandatory)

After approval and broadcast, always include a tx link. Use:
- `/tx/<txHash>` for transactions
- `/address/<address>` for addresses

Base URL comes from `wallets.chains.<chainId>.blockExplorerUrl` when configured, otherwise fallback well-known explorers.

## Agent tool expectations

If host tooling is available, prefer these tools:
- `wallet_create`, `wallet_send`, `wallet_balance`, `wallet_txStatus`, `wallet_approve`
- `wallet_list`, `wallet_setDefault`
- `wallet_erc20_approve`, `wallet_erc20_transfer`, `wallet_contract_call`

If the host provides CLI instead, use the host wallet CLI for create/address/send/approve and recover/import flows.

## Files and CLI

- Starter config: `wallet-config.json`
- Install skill in project: `openclast-wallet install-skill`
- Initialize config: `openclast-wallet init` or `openclast-wallet init --config ./wallet-config.json`
- Create wallet: `openclast-wallet create --config ./wallet-config.json` (defaults to `./wallet-config.json` if omitted)
- List wallets: `openclast-wallet list --config ./wallet-config.json`
- Set default wallet: `openclast-wallet set-default <walletId> --config ./wallet-config.json`
- Export key (gated): `MOLTBOT_ALLOW_WALLET_EXPORT=1 openclast-wallet export --config ./wallet-config.json --yes` (defaults to `./wallet-config.json` if omitted)
- Restore: `openclast-wallet restore --config ./wallet-config.json --private-key 0x...` or `--mnemonic "..."` / `--mnemonic-file <path>` (defaults to `./wallet-config.json` if omitted)

