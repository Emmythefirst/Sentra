/**
 * Sentra Swap Engine
 *
 * Routes through Zerion CLI's getSwapQuote + executeSwap.
 * All signing done via OWS (Open Wallet Standard) — no raw key exposure.
 */

import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

export function zerionAuth(): string {
  const key = process.env.ZERION_API_KEY;
  return `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
}

export async function getSolPrice(): Promise<number> {
  const response = await axios.get(
    'https://api.zerion.io/v1/fungibles/11111111111111111111111111111111',
    { headers: { Authorization: zerionAuth() } }
  );
  return response.data.data.attributes.market_data.price;
}

export interface SwapResult {
  signature: string;
  inputAmount: number;
  outputMint: string;
  price: number;
  liquiditySource?: string;
}

export async function executeZerionSwap(
  walletName: string,
  passphrase: string,
  walletAddress: string,
  fromToken: string,
  toToken: string,
  amount: number
): Promise<SwapResult> {
  if (!walletName || !passphrase || !walletAddress || !fromToken || !toToken || amount <= 0) {
    throw new Error(
      `[Swap] Invalid parameters: walletName=${walletName}, fromToken=${fromToken}, ` +
      `toToken=${toToken}, amount=${amount}, walletAddress=${walletAddress}`
    );
  }

  if (!process.env.ZERION_API_KEY) {
    throw new Error('[Swap] ZERION_API_KEY not set in environment');
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[Swap] Requesting Zerion quote: ${amount} ${fromToken} → ${toToken}`);
  console.log(`[Swap] Wallet: ${walletAddress}`);

  // @ts-ignore — JS module from forked CLI
  const { getSwapQuote, executeSwap } = await import('../../cli/lib/trading/swap.js');

  console.log(`[Swap] Module loaded ✅`);

  // Step 1 — Get quote
  let quote: any;
  try {
    quote = await getSwapQuote({
      fromToken,
      toToken,
      amount,
      fromChain: 'solana',
      toChain: 'solana',
      walletAddress,
    });
  } catch (err: any) {
    throw new Error(`Swap quote request failed: ${err.message}`);
  }

  if (!quote) throw new Error('Quote is empty or undefined');

  console.log(
    `[Swap] Quote received ✅ | Route: ${quote.liquiditySource || 'N/A'}\n` +
    `       From: ${quote.from?.symbol} (${quote.inputAmount})\n` +
    `       To: ${quote.to?.symbol} (~${quote.estimatedOutput})\n` +
    `       Fee: ${quote.fee?.protocolAmount || '0'} ${quote.from?.symbol}`
  );

  // Step 2 — Check preconditions
  if (quote.preconditions?.enough_balance === false) {
    throw new Error(
      `Insufficient ${fromToken} balance. Required: ${quote.inputAmount} — check wallet balance.`
    );
  }

  if (!quote.transaction?.raw && !quote.transaction?.data) {
    throw new Error(
      'Quote received but transaction data is missing (no raw or data field) — swap route temporarily unavailable.'
    );
  }

  // Step 3 — Sign and broadcast via Zerion CLI OWS
  console.log(`[Swap] Signing and broadcasting via Zerion CLI (OWS)...`);

  let result: any;
  try {
    result = await executeSwap(quote, walletName, passphrase);
  } catch (err: any) {
    const msg = err.message || String(err);
    if (msg.includes('insufficient lamports')) {
      console.error('[Swap] Tip: Wallet may need more SOL for network fees.');
    }
    if (msg.includes('blockhash not found')) {
      console.error('[Swap] Tip: Transaction stale — a fresh quote will be requested next cycle.');
    }
    throw new Error(`Failed to execute swap: ${msg}`);
  }

  // Step 4 — Fetch price for logging
  let price = 0;
  try {
    price = await getSolPrice();
  } catch {
    console.warn(`[Swap] ⚠️  Could not fetch SOL price for logging`);
  }

  const signature = result.hash || result.signature || '';

  console.log(`[Swap] ${'═'.repeat(60)}`);
  console.log(`[Swap] ✅ Swap completed successfully!`);
  console.log(`[Swap] Tx: ${signature}`);
  console.log(`[Swap] Explorer: https://explorer.solana.com/tx/${signature}`);
  console.log(`[Swap] ${'═'.repeat(60)}\n`);

  return {
    signature,
    inputAmount: amount,
    outputMint: toToken,
    price,
    liquiditySource: quote.liquiditySource,
  };
}
