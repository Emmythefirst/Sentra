/**
 * Token resolver — maps human input ("ETH", "USDC", "0xA0b8...") to Zerion fungible IDs.
 */

import * as api from "../api/client.js";
import { NATIVE_ASSET_ADDRESS } from "../util/constants.js";

// Hardcoded aliases for the most common tokens — avoids API call for basic swaps
// Note: Multi-chain tokens need special handling in resolveToken() below
const NATIVE_ALIASES = new Map([
  ["ETH", { fungibleId: "eth", symbol: "ETH", decimals: 18, address: NATIVE_ASSET_ADDRESS }],
  ["SOL", { fungibleId: "11111111111111111111111111111111", symbol: "SOL", decimals: 9, address: "So11111111111111111111111111111111111111112" }],
  ["WETH", { fungibleId: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", symbol: "WETH", decimals: 18 }],
  ["USDC", { fungibleId: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 }],
  ["USDT", { fungibleId: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", decimals: 6 }],
  ["DAI", { fungibleId: "0x6b175474e89094c44da98b954eedeac495271d0f", symbol: "DAI", decimals: 18 }],
  ["WBTC", { fungibleId: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", symbol: "WBTC", decimals: 8 }],
]);

// Solana token mappings.
// fungibleId = Zerion's canonical cross-chain ID (Ethereum contract address for ERC-20 equivalents).
// address    = Solana SPL token mint (used for token account lookups, not for swap API queries).
const SOLANA_ALIASES = new Map([
  ["USDC", { fungibleId: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6, address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }],
  ["USDT", { fungibleId: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", decimals: 6, address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenEu9p" }],
  ["SOL",  { fungibleId: "11111111111111111111111111111111",             symbol: "SOL",  decimals: 9, address: "So11111111111111111111111111111111111111112" }],
]);

/**
 * Resolve a token query to a Zerion-compatible fungible reference.
 * @param {string} query - Token name, symbol, or contract address
 * @param {string} [chainId] - Optional chain filter
 * @returns {Promise<{ fungibleId: string, symbol: string, decimals: number, name?: string, address?: string }>}
 */
export async function resolveToken(query, chainId) {
  const upper = query.toUpperCase();

  // 1. Check chain-specific aliases first
  if (chainId === "solana" && SOLANA_ALIASES.has(upper)) {
    console.log(`[ResolveToken] Using Solana alias for ${upper}`);
    return { ...SOLANA_ALIASES.get(upper), name: upper };
  }

  // 2. Check general native aliases
  if (NATIVE_ALIASES.has(upper)) {
    const alias = NATIVE_ALIASES.get(upper);
    return { ...alias, name: upper };
  }

  // 3. If it looks like a contract address, resolve decimals from API
  if (query.startsWith("0x") && query.length >= 40) {
    const addr = query.toLowerCase();
    console.log(`[ResolveToken] Resolving contract address: ${addr.slice(0, 10)}...`);
    // Try to get actual decimals from chain-specific implementation
    try {
      const response = await api.searchFungibles(addr, { chainId, limit: 1 });
      const match = response.data?.[0];
      if (match) {
        const impl = (match.attributes?.implementations || []).find(
          (i) => i.chain_id === chainId
        ) || match.attributes?.implementations?.[0];
        return {
          fungibleId: match.id,
          symbol: match.attributes?.symbol || addr.slice(0, 6) + "...",
          decimals: impl?.decimals ?? 18,
          address: impl?.address || addr,
          name: match.attributes?.name || "Unknown",
        };
      }
    } catch { /* fall through to default */ }
    return {
      fungibleId: addr,
      symbol: addr.slice(0, 6) + "...",
      decimals: 18,
      address: addr,
      name: "Unknown",
    };
  }

  // 4. Search via Zerion Fungibles API
  console.log(`[ResolveToken] Searching for "${query}" on chain ${chainId}...`);
  const response = await api.searchFungibles(query, { chainId, limit: 5 });
  const results = response.data || [];

  if (results.length === 0) {
    const err = new Error(`Could not resolve token "${query}"`);
    err.code = "invalid_token";
    err.suggestion = `Try: zerion search ${query}`;
    throw err;
  }

  // Prefer verified tokens
  const verified = results.find((r) => r.attributes?.flags?.verified);
  const best = verified || results[0];

  const impl = best.attributes?.implementations?.[0];

  console.log(`[ResolveToken] Resolved "${query}":`, {
    symbol: best.attributes?.symbol,
    fungibleId: best.id,
    address: impl?.address,
  });

  return {
    fungibleId: best.id,
    symbol: best.attributes?.symbol,
    name: best.attributes?.name,
    decimals: impl?.decimals ?? 18,
    address: impl?.address,
  };
}
