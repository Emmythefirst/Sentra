/**
 * Core swap/bridge logic — the revenue-generating pipeline.
 *
 * Flow: resolveTokens → getQuote → (simulate) → (approve) → sign → broadcast
 */

import { parseUnits } from "viem";
import * as api from "../api/client.js";
import { resolveToken } from "./resolve-token.js";
import { signSwapTransaction, broadcastAndWait, approveErc20 } from "./transaction.js";
import { signAndBroadcastSolana } from "../chain/solana.js";
import { isSolana } from "../chain/registry.js";
import { getConfigValue } from "../config.js";
import { NATIVE_ASSET_ADDRESS, DEFAULT_SLIPPAGE } from "../util/constants.js";
import { enforceExecutablePolicies } from "./guards.js";

/**
 * Get a swap/bridge quote from Zerion API.
 */
export async function getSwapQuote({
  fromToken,
  toToken,
  amount,
  fromChain,
  toChain,
  walletAddress,
  slippage,
}) {
  console.log(`[SwapQuote] Resolving tokens: ${fromToken} (${fromChain}) → ${toToken} (${toChain})`);
  const [fromResolved, toResolved] = await Promise.all([
    resolveToken(fromToken, fromChain),
    resolveToken(toToken, toChain),
  ]);

  console.log(`[SwapQuote] From token resolved:`, {
    symbol: fromResolved.symbol,
    decimals: fromResolved.decimals,
    fungibleId: fromResolved.fungibleId,
  });
  console.log(`[SwapQuote] To token resolved:`, {
    symbol: toResolved.symbol,
    decimals: toResolved.decimals,
    fungibleId: toResolved.fungibleId,
  });

  // Convert amount to smallest units using viem's parseUnits for precision
  // Note: /swap/quotes/ API expects human-readable amount, NOT smallest units
  console.log(`[SwapQuote] Amount conversion: ${amount} (keeping human-readable format for /swap/quotes/)`);

  const amountInSmallestUnits = parseUnits(String(amount), fromResolved.decimals);

  const params = {
    // Top-level params required by /swap/quotes/
    from: walletAddress,
    to: walletAddress, // For same-chain swaps, recipient is the same wallet
    currency: "usd",
    // Nested input parameters (required)
    "input[chain_id]": fromChain,
    "input[fungible_id]": fromResolved.fungibleId,
    "input[amount]": String(amount), // Use human-readable amount, not smallest units
    // Nested output parameters (required) 
    "output[chain_id]": toChain || fromChain,
    "output[fungible_id]": toResolved.fungibleId,
    // Note: removed slippage_percent to test if it's causing the issue
  };

  console.log(`[SwapQuote] Calling Zerion API with params:`, params);

  let response;
  try {
    response = await api.getSwapOffers(params);
  } catch (err) {
    console.error(`[SwapQuote] Zerion API error:`, err.message);
    console.error(`[SwapQuote] Error status:`, err.status);
    console.error(`[SwapQuote] Error code:`, err.code);
    if (err.response) {
      console.error(`[SwapQuote] Response data:`, JSON.stringify(err.response, null, 2));
    }
    console.error(`[SwapQuote] Full error:`, JSON.stringify({
      message: err.message,
      status: err.status,
      code: err.code,
      response: err.response,
      stack: err.stack?.split('\n').slice(0, 3).join('\n'),
    }, null, 2));
    
    // Provide helpful troubleshooting for 400 errors on Solana
    if (err.status === 400 && fromChain === 'solana') {
      console.error(`[SwapQuote] ⚠️  Note: Zerion /swap/offers/ may have limited support for Solana swaps.`);
      console.error(`[SwapQuote]    Try: 1) Check fungible IDs with 'zerion search USDC --chain solana'`);
      console.error(`[SwapQuote]    2) Ensure wallet has sufficient balance`);
      console.error(`[SwapQuote]    3) Contact Zerion support about Solana swap endpoint limitations`);
    }
    
    throw err;
  }

  const offers = response.data || [];
  console.log(`[SwapQuote] Received ${offers.length} offers from Zerion API`);

  if (offers.length === 0) {
    const err = new Error(
      `No swap route found for ${amount} ${fromResolved.symbol} → ${toResolved.symbol} on ${fromChain}. ` +
      `Minimum swap is ~$1. ` +
      `Check your balance and chain with: zerion portfolio`
    );
    err.code = "no_route";
    err.suggestion = `Try: zerion swap ETH USDC 0.001 --chain ${fromChain}`;
    throw err;
  }

  const best = offers[0];
  const attrs = best.attributes;

  // Map the API's `error` field to a preconditions object that the rest of the
  // pipeline understands. The API returns 200 even for unfunded wallets but sets
  // error.code so callers know a precondition failed.
  const apiErr = attrs.error;
  const preconditions = {
    enough_balance: !apiErr || apiErr.code !== "not_enough_input_asset_balance",
    enough_allowance: !apiErr || apiErr.code !== "not_enough_allowance",
    ...(apiErr ? { apiError: apiErr } : {}),
  };

  // Derive the on-chain token address for ERC-20 approval (EVM only).
  // For Solana we use the address from SOLANA_ALIASES directly.
  const chainTokenAddress = fromResolved.address;

  // The API returns transaction data under `transaction_swap.<chain>` (new format).
  // For Solana: { raw: "<base64 serialized VersionedTransaction>" }
  // For EVM: fall back to the legacy `transaction` field ({ to, data, value, ... })
  const transactionData = fromChain === "solana"
    ? (attrs.transaction_swap?.solana || attrs.transaction)
    : (attrs.transaction || attrs.transaction_swap?.[fromChain]);

  return {
    id: best.id,
    from: {
      ...fromResolved,
      chainAddress: chainTokenAddress,
    },
    to: toResolved,
    inputAmount: amount,
    inputAmountRaw: amountInSmallestUnits,
    estimatedOutput: attrs.output_amount?.quantity,
    outputMin: attrs.minimum_output_amount?.quantity,
    gas: null,
    estimatedSeconds: null,
    fee: {
      protocolPercent: attrs.protocol_fee?.percentage,
      protocolAmount: attrs.protocol_fee?.amount?.quantity,
    },
    liquiditySource: attrs.liquidity_source?.name,
    preconditions,
    spender: attrs.asset_spender,
    transaction: transactionData,
    fromChain,
    toChain: toChain || fromChain,
    slippageType: attrs.slippage_percent,
  };
}

/**
 * Execute a swap — handle approval if needed, sign, broadcast.
 * @param {object} quote
 * @param {string} walletName
 * @param {string} passphrase
 * @param {object} [options]
 * @param {number} [options.timeout] - broadcast timeout in seconds
 */
export async function executeSwap(quote, walletName, passphrase, { timeout } = {}) {
  const zerionChainId = quote.fromChain;
  const isCrossChain = quote.fromChain !== quote.toChain;

  // Enforce executable policies before signing
  const tx = quote.transaction || {};
  await enforceExecutablePolicies({ to: tx.to, value: tx.value, data: tx.data });

  // Route: Solana vs EVM
  if (isSolana(zerionChainId)) {
    return executeSolanaSwap(quote, walletName, passphrase);
  }

  return executeEvmSwap(quote, walletName, passphrase, zerionChainId, { timeout, isCrossChain });
}

async function executeSolanaSwap(quote, walletName, passphrase) {
  const result = await signAndBroadcastSolana(
    quote.transaction,
    walletName,
    passphrase
  );

  return {
    ...result,
    swap: {
      from: `${quote.inputAmount} ${quote.from.symbol}`,
      to: `~${quote.estimatedOutput} ${quote.to.symbol}`,
      fee: quote.fee,
      source: quote.liquiditySource,
    },
  };
}

async function executeEvmSwap(quote, walletName, passphrase, zerionChainId, { timeout, isCrossChain = false } = {}) {
  // Snapshot destination balance before bridge (for delivery detection)
  let preBalance = null;
  if (isCrossChain) {
    preBalance = await getDestinationBalance(quote);
  }

  // 1. Handle ERC-20 approval if needed
  if (
    quote.preconditions.enough_allowance === false &&
    quote.spender &&
    quote.from.chainAddress !== NATIVE_ASSET_ADDRESS
  ) {
    const tokenAddr = quote.from.chainAddress;
    const approvalAmount = BigInt(quote.inputAmountRaw);
    const approvalResult = await approveErc20(
      tokenAddr,
      quote.spender,
      approvalAmount,
      zerionChainId,
      walletName,
      passphrase
    );

    if (approvalResult.status !== "success") {
      const err = new Error(
        `ERC-20 approval failed for ${quote.from.symbol} on ${zerionChainId}. ` +
        `Token: ${tokenAddr}, Spender: ${quote.spender}. ` +
        `Tx: ${approvalResult.hash}`
      );
      err.code = "approval_failed";
      err.approvalHash = approvalResult.hash;
      throw err;
    }

  }

  // 2. Sign the swap transaction
  const { signedTxHex, client } = await signSwapTransaction(
    quote.transaction,
    zerionChainId,
    walletName,
    passphrase
  );

  // 3. Broadcast and wait for source chain confirmation
  const result = await broadcastAndWait(client, signedTxHex, { timeout, isCrossChain });

  // 4. For cross-chain: poll destination chain for delivery
  if (isCrossChain && result.status === "success") {
    if (preBalance === null) {
      result.bridgeDelivery = {
        status: "unknown",
        reason: "Could not snapshot destination balance before bridge. Check manually.",
        suggestion: `zerion positions --chain ${quote.toChain}`,
      };
    } else {
      const bridgeTimeout = timeout || 300; // 5 min default for bridge delivery
      const delivery = await waitForBridgeDelivery(quote, preBalance, bridgeTimeout);
      result.bridgeDelivery = delivery;
    }
  }

  return {
    ...result,
    swap: {
      from: `${quote.inputAmount} ${quote.from.symbol}`,
      to: `~${quote.estimatedOutput} ${quote.to.symbol}`,
      fee: quote.fee,
      source: quote.liquiditySource,
    },
  };
}

/**
 * Fetch the balance of a token on a specific chain for a wallet address.
 * Returns 0 if the token is not found or the API call fails.
 */
async function fetchTokenBalance(walletAddress, chainId, tokenSymbol) {
  const response = await api.getPositions(walletAddress, { chainId });
  const upperSymbol = tokenSymbol.toUpperCase();
  const match = (response.data || []).find(
    (p) => p.attributes.fungible_info?.symbol?.toUpperCase() === upperSymbol
  );
  return match?.attributes?.quantity?.float ?? 0;
}

/**
 * Get the current balance of the destination token on the destination chain.
 * Used as a "before" snapshot to detect bridge delivery.
 */
async function getDestinationBalance(quote) {
  try {
    return await fetchTokenBalance(
      quote.transaction?.from || "",
      quote.toChain,
      quote.to.symbol
    );
  } catch (err) {
    process.stderr.write(
      `Warning: could not snapshot destination balance (${err.message}). ` +
      `Bridge delivery detection may be inaccurate.\n`
    );
    return null;
  }
}

/**
 * Poll destination chain balance until it increases (bridge delivery) or timeout.
 *
 * Strategy: the quote includes `estimatedSeconds` from the bridge provider.
 * We wait for that duration first (no point polling before the relay is expected),
 * then poll every 10s. If no estimate, start polling after 10s.
 */
async function waitForBridgeDelivery(quote, preBalance, timeoutSeconds) {
  const walletAddress = quote.transaction?.from;
  if (!walletAddress) {
    return { status: "unknown", reason: "no wallet address in quote" };
  }

  const estimatedWait = quote.estimatedSeconds || 0;
  const initialDelay = Math.min(Math.max(estimatedWait, 10), timeoutSeconds / 2);
  const pollInterval = 10_000;
  const { toChain } = quote;
  const tokenSymbol = quote.to.symbol;

  process.stderr.write(
    `Waiting for bridge delivery on ${toChain}` +
    (estimatedWait ? ` (estimated ${estimatedWait}s)` : "") +
    `, timeout ${timeoutSeconds}s...\n`
  );

  process.stderr.write(`Waiting ${initialDelay}s for relay before checking...\n`);
  await new Promise((r) => setTimeout(r, initialDelay * 1000));

  const deadline = Date.now() + (timeoutSeconds - initialDelay) * 1000;
  let polls = 0;
  let consecutiveErrors = 0;

  while (Date.now() < deadline) {
    polls++;

    try {
      const currentBalance = await fetchTokenBalance(walletAddress, toChain, tokenSymbol);
      consecutiveErrors = 0;

      // Use epsilon to avoid floating-point false positives/negatives
      const EPSILON = 1e-9;
      if (currentBalance - preBalance > EPSILON) {
        const received = currentBalance - preBalance;
        process.stderr.write(
          `Bridge delivery confirmed: +${received.toFixed(6)} ${tokenSymbol} on ${toChain}\n`
        );
        return { status: "delivered", received, destinationChain: toChain, token: tokenSymbol, polls };
      }

      process.stderr.write(`Poll ${polls}: no change yet on ${toChain}...\n`);
    } catch (err) {
      consecutiveErrors++;
      process.stderr.write(`Poll ${polls}: API error (${err.message}), retrying...\n`);
      if (consecutiveErrors >= 5) {
        process.stderr.write("Too many consecutive API errors. Giving up on delivery detection.\n");
        return {
          status: "error",
          reason: `${consecutiveErrors} consecutive API failures`,
          lastError: err.message,
          suggestion: `zerion positions --chain ${toChain}`,
        };
      }
    }

    if (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollInterval));
    }
  }

  process.stderr.write(
    `Bridge delivery not confirmed within ${timeoutSeconds}s. ` +
    `Funds may still arrive — check with: zerion positions --chain ${toChain}\n`
  );
  return {
    status: "timeout",
    destinationChain: toChain,
    token: tokenSymbol,
    polls,
    suggestion: `zerion positions --chain ${toChain}`,
  };
}
