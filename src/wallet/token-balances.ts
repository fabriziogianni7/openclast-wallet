/**
 * Read-only ERC20 balanceOf for known tokens per chain.
 */

import type { Address } from "viem";
import { parseAbi, type PublicClient } from "viem";

const ERC20_BALANCE_ABI = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

export type KnownToken = {
  address: string;
  symbol: string;
  decimals: number;
};

export type TokenBalance = {
  tokenAddress: string;
  symbol: string;
  decimals: number;
  balanceWei: string;
};

export const KNOWN_TOKENS_BY_CHAIN: Record<number, KnownToken[]> = {
  1: [
    { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", decimals: 18 },
    { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
    { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6 },
    { address: "0x6B175474E89094C44Da98b954Eedeac495271d0F", symbol: "DAI", decimals: 18 },
    { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "WBTC", decimals: 8 },
  ],
  11155111: [
    { address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", symbol: "WETH", decimals: 18 },
    { address: "0x779877A7B0D9E8603169DdbD7836e478b4624789", symbol: "LINK", decimals: 18 },
    { address: "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8", symbol: "USDC", decimals: 6 },
  ],
  137: [
    { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", symbol: "WMATIC", decimals: 18 },
    { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", symbol: "USDC", decimals: 6 },
    { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", symbol: "USDT", decimals: 6 },
  ],
  8453: [
    { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
    { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
  ],
  42161: [
    { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", symbol: "WETH", decimals: 18 },
    { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", decimals: 6 },
    { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT", decimals: 6 },
  ],
};

export async function getTokenBalances(
  publicClient: PublicClient,
  chainId: number,
  walletAddress: string,
): Promise<TokenBalance[]> {
  const tokens = KNOWN_TOKENS_BY_CHAIN[chainId];
  if (!tokens || tokens.length === 0) return [];

  const wallet = (walletAddress.startsWith("0x") ? walletAddress : "0x" + walletAddress) as Address;
  const results: TokenBalance[] = [];

  for (const token of tokens) {
    const addr = (token.address.startsWith("0x") ? token.address : "0x" + token.address) as Address;
    try {
      const balance = await publicClient.readContract({
        address: addr,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [wallet],
      });
      if (balance > 0n) {
        results.push({
          tokenAddress: token.address,
          symbol: token.symbol,
          decimals: token.decimals,
          balanceWei: balance.toString(),
        });
      }
    } catch {
      // Skip token if RPC fails
    }
  }

  return results;
}
