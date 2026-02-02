/**
 * EVM RPC client for wallet (Sepolia or configurable chain) using viem.
 */

import {
  createPublicClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { defineChain } from "viem";

export type RpcClient = {
  getBalance(address: string): Promise<bigint>;
  getTransactionCount(address: string): Promise<number>;
  estimateGas(params: { from: string; to: string; value: bigint; data?: string }): Promise<bigint>;
  sendRawTransaction(signedHex: string): Promise<string>;
  /** viem PublicClient for prepareTransactionRequest and other advanced use */
  publicClient: PublicClient;
};

function toAddress(value: string): Address {
  const s = value.trim();
  return (s.startsWith("0x") ? s : `0x${s}`) as Address;
}

function toHex(value: string | undefined): Hex | undefined {
  if (value == null || value === "") return undefined;
  const s = value.trim();
  return (s.startsWith("0x") ? s : `0x${s}`) as Hex;
}

/**
 * Create an RPC client backed by viem PublicClient (http transport).
 */
export function createRpcClient(rpcUrl: string, chainId: number = 11155111): RpcClient {
  const url = rpcUrl.trim();
  if (!url) throw new Error("RPC URL required");

  const chain = defineChain({
    id: chainId,
    name: chainId === 11155111 ? "Sepolia" : `Chain ${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: { http: [url] },
    },
  });

  const client = createPublicClient({
    chain,
    transport: http(url, {
      retryCount: 2,
      timeout: 15_000,
    }),
  });

  return {
    publicClient: client,
    async getBalance(address: string): Promise<bigint> {
      return client.getBalance({ address: toAddress(address) });
    },
    async getTransactionCount(address: string): Promise<number> {
      return client.getTransactionCount({ address: toAddress(address) });
    },
    async estimateGas(params: {
      from: string;
      to: string;
      value: bigint;
      data?: string;
    }): Promise<bigint> {
      return client.estimateGas({
        account: toAddress(params.from),
        to: toAddress(params.to),
        value: params.value,
        data: toHex(params.data),
      });
    },
    async sendRawTransaction(signedHex: string): Promise<string> {
      const serialized = (signedHex.startsWith("0x") ? signedHex : `0x${signedHex}`) as Hex;
      return client.sendRawTransaction({ serializedTransaction: serialized });
    },
  };
}
