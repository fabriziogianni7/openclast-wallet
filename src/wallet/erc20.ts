/**
 * ERC20 ABI slice and encoding for approve/transfer.
 */

import { encodeFunctionData, parseAbi } from "viem";

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

export function encodeErc20Approve(spender: string, amountWei: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender as `0x${string}`, amountWei],
  });
}

export function encodeErc20Transfer(to: string, amountWei: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to as `0x${string}`, amountWei],
  });
}
