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

### Wallet management
  - `wallet_create` — create a new wallet (keys never exposed)
  - `wallet_list` — list wallets + default
  - `wallet_setDefault` — set default wallet
  - `wallet_address` — get default wallet address (or by walletId)

### Balance & read
  - `wallet_balance` — get native balance, optionally ERC-20 balances. Supports `allChains: true` for portfolio view and `tokenAddress` for arbitrary ERC20 queries.
  - `wallet_readContract` — read-only contract call (eth_call). No approval needed. Returns raw hex.
  - `wallet_chains` — list all configured chains, names, RPCs, explorers.

### ABI encoding
  - `wallet_encodeCall` — encode calldata from a function signature + args. Use this to build `data` for `wallet_contract_call` and `wallet_readContract`.

### Transactions (write, requires approval)
  - `wallet_send` — create pending native send
  - `wallet_erc20_approve` — create pending ERC-20 approve
  - `wallet_erc20_transfer` — create pending ERC-20 transfer
  - `wallet_contract_call` — create pending arbitrary contract call (manual params)
  - `wallet_sendTransaction` — create pending tx from a raw `transactionRequest` object (from LI.FI, 1inch, CoW, etc). **Use this when a protocol API gives you a ready-made transactionRequest.**

### Approval flow
  - `wallet_approve` — approve + broadcast pending tx
  - `wallet_reject` — reject/cancel a pending tx
  - `wallet_listPending` — list all pending transactions awaiting approval
  - `wallet_txStatus` — get pending tx status

### History
  - `wallet_history` — query audit log (filter by wallet, chain, action)

## Human-readable amounts

All transaction tools (`wallet_send`, `wallet_erc20_approve`, `wallet_erc20_transfer`, `wallet_contract_call`) accept human-readable amounts:

- **Native ETH**: use `amount` + `unit` (e.g. `amount: "0.5"`, `unit: "ether"`)
- **ERC20 tokens**: use `amount` + `decimals` (e.g. `amount: "100"`, `decimals: 6` for USDC)
- **Raw wei**: use `valueWei` or `amountWei` directly (legacy, still supported)

Supported units: `wei`, `kwei`, `mwei`, `gwei`, `szabo`, `finney`, `ether`/`eth`.

When the user says "send 0.5 ETH", use `amount: "0.5"`, `unit: "ether"`. Do NOT try to manually convert to wei.

## Config
- Prefer `wallet-config.json` in the project root and customize chains and limits before use.
- Keep `wallet-config.json` separate from `openclaw.json` (Openclaw config does not accept a top-level `wallets` key).
- Use `wallet_chains` to discover available chains before assuming chain IDs.

## Approval flow (mandatory)

All send/approve/contract operations create a **pending transaction** that requires explicit approval.
Always:
1. Create the pending tx (send/erc20/contract call).
2. Ask the user to approve.
3. Only after approval, broadcast and confirm.

If the user asks to "just send," send that transaction without asking for approval again, and give a recap of the transaction.

If the user says "cancel" or "reject", use `wallet_reject` with the txId.

To see what's waiting, use `wallet_listPending`.

Status semantics:
- `pending`: waiting for user approval; **not** broadcast yet.
- `sent`: broadcast to the network; may still be unconfirmed.
- `failed`: signing or broadcast failed.
- `rejected`: approval was declined.

## Telegram approval flow (when running on Telegram)

When you create a pending transaction, ALWAYS present it with inline approve/reject buttons using the `message` tool:

1. Create the pending tx (wallet_send / wallet_sendTransaction / etc).
2. Send an approval message with buttons:
   - Use the `message` tool with `action: "send"`, `channel: "telegram"`.
   - Set `to` to the current chat/user ID.
   - Include `buttons` with Approve and Reject options.
   - Put the txId in the callback_data (Telegram limits callback_data to 64 bytes; use short prefixes like `approve <txId>` and `reject <txId>`).

Example message tool call after creating a pending tx with txId "abc-123":
```json
{
  "action": "send",
  "channel": "telegram",
  "message": "Transaction pending:\n\nSwap 0.05 ETH -> ~127 USDC on Base\nVia: LI.FI (Uniswap V3)\nGas: ~$0.02\n\nApprove or reject?",
  "buttons": [[
    { "text": "Approve", "callback_data": "approve abc-123" },
    { "text": "Reject", "callback_data": "reject abc-123" }
  ]]
}
```

3. When you receive a message starting with "approve " followed by a txId, call `wallet_approve` with that txId.
4. When you receive a message starting with "reject " followed by a txId, call `wallet_reject` with that txId.

## Key export warning (mandatory)

Never expose private keys by default. If the user asks for export:
- Require explicit confirmation.
- Warn that key export is dangerous and should be protected.
- Use environment gates if available (e.g., `MOLTBOT_ALLOW_WALLET_EXPORT=1`) and explicit CLI confirmation.

If export is not supported in this host, say so and offer safer alternatives.
Wallet creation is safe: `wallet_create` returns address metadata only (no keys).

## Common tasks

### Balance and tokens
- There is no default chain; the wallet is chain-agnostic.
- EVM wallet addresses are chain-agnostic; do not ask to switch wallets for a balance check.
- When a user asks for a balance, use `wallet_balance` with `allChains: true` to check all configured chains at once.
- To check a specific ERC20 token, use the `tokenAddress` parameter.
- If multiple wallets exist and the user does not specify one, use the default wallet.
- If a chain is not configured, read-only balance may still be possible via well-known public RPCs.

### Reading contract state (no tx needed)
- Use `wallet_encodeCall` to build calldata, then `wallet_readContract` to execute.
- Example: check an ERC20 allowance:
  1. `wallet_encodeCall` with `functionSignature: "allowance(address,address)"`, `args: ["0xOwner", "0xSpender"]`
  2. `wallet_readContract` with the returned `data` and the token's `to` address.

### Interacting with DeFi contracts (manual)
- Use `wallet_encodeCall` to build calldata for any function signature.
- Pass the encoded `data` to `wallet_contract_call`.
- Example: swap on a DEX:
  1. `wallet_encodeCall` with the swap function signature and args.
  2. `wallet_contract_call` with the encoded data, contract address, and optional ETH value.
  3. Wait for user approval, then `wallet_approve`.

### Executing protocol transaction requests (LI.FI, 1inch, CoW, etc.)

Other skills (e.g. LI.FI, 1inch) handle quoting and route selection. They return a `transactionRequest` object. **Use `wallet_sendTransaction` to execute it.** Do NOT decompose it into individual params.

#### When you receive a `transactionRequest` from another skill
1. If the source token is ERC20 (not native ETH) and an `approvalAddress` is provided, call `wallet_erc20_approve` first with `spender` set to the `approvalAddress`.
2. Pass the **entire** `transactionRequest` object to `wallet_sendTransaction`:
   ```json
   {
     "transactionRequest": {
       "to": "0x1111111254fb6c44bac0bed2854e76f90643097d",
       "data": "0x...",
       "value": "0x0de0b6b3a7640000",
       "chainId": 137,
       "gasLimit": "0x0e9cb2",
       "gasPrice": "0xb2d05e00"
     }
   }
   ```
3. `wallet_sendTransaction` auto-converts hex values to decimal internally.
4. Approve or reject the pending tx as usual.

#### Key rules
- **Never** manually convert hex values -- `wallet_sendTransaction` handles it.
- **Never** decompose the object into separate `wallet_contract_call` params -- pass it as one object.
- Always show the user the estimated outcome (toAmount, fees, slippage) before asking for approval.

### Listing wallets
- Only show wallet addresses in agent when asking about listing wallets, not IDs.

### Sending
- **CRITICAL: Always extract the chain from the user's message and pass `chainId` explicitly.** If the user says "on Base", pass `chainId: 8453`. If the user says "on Polygon", pass `chainId: 137`. Never rely on the default chain when the user specifies one.
- Validate chainId and recipient.
- Respect per-tx and daily limits from config.
- Always provide a block explorer link when a tx is confirmed.
- Prefer `amount` + `unit` over raw wei for user-facing amounts.

### Chain name → chainId (MUST use when user mentions a chain)

- Ethereum / Mainnet / ETH mainnet: `1`
- Sepolia: `11155111`
- Polygon / Matic: `137`
- Base: `8453`
- Arbitrum / Arbitrum One: `42161`
- Optimism / OP: `10`
- Fantom: `250`
- Avalanche / Avax: `43114`
- Binance Smart Chain / BSC / BNB Chain: `56`

**When the user says "on <chain>" or mentions a chain name, you MUST map it to the chainId above and pass it in every tool call.** Never omit `chainId` when the user specifies a chain.

Use `wallet_chains` to discover configured chains dynamically. Use Sepolia only if the user explicitly says "Sepolia".

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

## History

Use `wallet_history` to answer questions like "what did I send yesterday" or "show my recent transactions". Filter by:
- `walletId` — specific wallet
- `chainId` — specific chain
- `action` — event type (e.g. `send_approved`, `erc20_transfer_requested`)
- `limit` — number of entries (default 50)
