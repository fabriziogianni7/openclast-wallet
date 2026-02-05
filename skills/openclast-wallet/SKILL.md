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

## Exposed tools
  - `wallet_address` — get default wallet address (or by walletId)
  - `wallet_balance` — get native balance (optionally ERC‑20 balances)
  - `wallet_create` — create a new wallet
  - `wallet_list` — list wallets + default
  - `wallet_setDefault` — set default wallet
  - `wallet_send` — create pending native send
  - `wallet_erc20_approve` — create pending ERC‑20 approve
  - `wallet_erc20_transfer` — create pending ERC‑20 transfer
  - `wallet_contract_call` — create pending contract call
  - `wallet_txStatus` — get pending tx status
  - `wallet_approve` — approve + broadcast pending tx

## Config
- Prefer `wallet-config.json` in the project root and customize chains and limits before use.
- Keep `wallet-config.json` separate from `openclaw.json` (Openclaw config does not accept a top-level `wallets` key).

## Approval flow (mandatory)

All send/approve/contract operations create a **pending transaction** that requires explicit approval.
Always:
1. Create the pending tx (send/erc20/contract call).
2. Ask the user to approve.
3. Only after approval, broadcast and confirm.

If the user asks to “just send,” send that transaction without asking for approval again, and give a recap of the transaction.

Status semantics:
- `pending`: waiting for user approval; **not** broadcast yet.
- `sent`: broadcast to the network; may still be unconfirmed.
- `failed`: signing or broadcast failed.
- `rejected`: approval was declined.

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
- when a user asks for a balance, use the `wallet_balance` tool to get the balance and check all the configuredchains.
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

Use Sepolia only if specified by the user.

Token address reference:
- See `skills/openclast-wallet/TOKENS.md` for common token addresses.
- Always verify addresses before sending.

## Safety defaults

- Default mode is notify/approval, not auto-send.
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


