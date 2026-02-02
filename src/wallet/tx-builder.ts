/**
 * Build and sign EVM transactions using viem.
 * Uses EIP-1559 fees with a buffer to avoid "transaction underpriced" errors.
 */

import type { Hex } from "viem";
import { type Address, privateKeyToAccount } from "viem/accounts";
import type { RpcClient } from "./rpc.js";

const GAS_FEE_BUFFER_MULTIPLIER = 120n;
const GAS_FEE_BUFFER_DIVISOR = 100n;

export type TxParams = {
  from: string;
  to: string;
  valueWei: bigint;
  data?: string;
  gasLimit?: bigint;
  nonce?: number;
};

export type SignedTx = {
  signedHex: string;
  nonce: number;
};

export function privateKeyToAddress(privateKeyHex: string): string {
  const key = (privateKeyHex.startsWith("0x") ? privateKeyHex : "0x" + privateKeyHex) as Hex;
  const account = privateKeyToAccount(key);
  return account.address as string;
}

export async function buildAndSignTx(params: {
  privateKeyHex: string;
  chainId: number;
  to: string;
  valueWei: bigint;
  data?: string;
  rpc: RpcClient;
}): Promise<SignedTx> {
  const key = (params.privateKeyHex.startsWith("0x")
    ? params.privateKeyHex
    : "0x" + params.privateKeyHex) as Hex;
  const account = privateKeyToAccount(key);
  const to = params.to as Address;
  const data = params.data ? (params.data.startsWith("0x") ? params.data : `0x${params.data}`) as Hex : undefined;

  const from = account.address as Address;
  const nonce = await params.rpc.getTransactionCount(from);
  const gasLimit = await params.rpc.estimateGas({
    from,
    to,
    value: params.valueWei,
    data: params.data,
  });
  const gas = gasLimit + BigInt(10000);

  const client = params.rpc.publicClient;

  let tx: Parameters<typeof account.signTransaction>[0];
  try {
    const fees = await client.estimateFeesPerGas();
    const maxFeePerGas = (fees.maxFeePerGas * GAS_FEE_BUFFER_MULTIPLIER) / GAS_FEE_BUFFER_DIVISOR;
    const maxPriorityFeePerGas =
      (fees.maxPriorityFeePerGas * GAS_FEE_BUFFER_MULTIPLIER) / GAS_FEE_BUFFER_DIVISOR;
    tx = {
      type: "eip1559",
      nonce,
      chainId: params.chainId,
      to,
      value: params.valueWei,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      data: (params.data ?? "0x") as Hex,
    };
  } catch {
    const gasPrice = await client.getGasPrice();
    const gasPriceBuffered = (gasPrice * GAS_FEE_BUFFER_MULTIPLIER) / GAS_FEE_BUFFER_DIVISOR;
    tx = {
      type: "legacy",
      nonce,
      chainId: params.chainId,
      to,
      value: params.valueWei,
      gas,
      gasPrice: gasPriceBuffered,
      data: (params.data ?? "0x") as Hex,
    };
  }

  const signedHex = await account.signTransaction(tx);
  return { signedHex, nonce };
}
