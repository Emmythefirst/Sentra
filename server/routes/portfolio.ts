import express, { Request, Response } from 'express';
import axios from 'axios';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

const zerionAuth = () => {
  const key = process.env.ZERION_API_KEY;
  return `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
};

let _priceCache: { price: number; change24h: number; ts: number } | null = null;
let _nextRetryAt = 0;
const PRICE_TTL = 5 * 60_000;        // 5 minutes
const RATE_LIMIT_BACKOFF = 10 * 60_000; // 10 minutes after a 429

async function getCachedSolPrice(): Promise<{ price: number; change24h: number } | null> {
  const now = Date.now();
  if (_priceCache && now - _priceCache.ts < PRICE_TTL) {
    return { price: _priceCache.price, change24h: _priceCache.change24h };
  }
  if (now < _nextRetryAt) {
    // Still in backoff — return stale cache if we have one, otherwise null
    return _priceCache ? { price: _priceCache.price, change24h: _priceCache.change24h } : null;
  }
  try {
    const res = await axios.get(
      'https://api.zerion.io/v1/fungibles/11111111111111111111111111111111',
      { headers: { Authorization: zerionAuth() } }
    );
    const price = res.data.data.attributes.market_data.price;
    const change24h = res.data.data.attributes.market_data.changes.percent_1d;
    _priceCache = { price, change24h, ts: now };
    _nextRetryAt = 0;
    return { price, change24h };
  } catch (err: any) {
    if (err.response?.status === 429) {
      _nextRetryAt = now + RATE_LIMIT_BACKOFF;
      console.warn(`[Portfolio] 429 received — backing off Zerion price calls for 10 minutes`);
      return _priceCache ? { price: _priceCache.price, change24h: _priceCache.change24h } : null;
    }
    throw err;
  }
}

// GET /api/portfolio/test
router.get('/test', async (req: Request, res: Response) => {
  try {
    console.log('[Portfolio] Running API test...');
    console.log(`[Portfolio] ZERION_API_KEY set: ${!!process.env.ZERION_API_KEY}`);
    
    const authHeader = zerionAuth();
    console.log(`[Portfolio] Auth header: ${authHeader.slice(0, 30)}...`);
    
    console.log('[Portfolio] Testing Zerion API endpoint: /v1/fungibles/...');
    const response = await axios.get(
      'https://api.zerion.io/v1/fungibles/?filter[chain_id]=solana&filter[search_query]=SOL',
      { 
        headers: { 
          Authorization: authHeader, 
          'Content-Type': 'application/json' 
        },
        timeout: 10000,
      }
    );
    
    console.log('[Portfolio] ✅ API test successful');
    console.log(`[Portfolio] Response status: ${response.status}`);
    console.log(`[Portfolio] Response data keys: ${Object.keys(response.data).join(', ')}`);
    
    res.json({ success: true, data: response.data });
  } catch (err: any) {
    console.error(`[Portfolio] ❌ API test failed: ${err.message}`);
    if (err.response?.status) {
      console.error(`[Portfolio] Status: ${err.response.status} ${err.response.statusText}`);
      console.error(`[Portfolio] Response: ${JSON.stringify(err.response.data).slice(0, 300)}`);
    } else if (err.code) {
      console.error(`[Portfolio] Error code: ${err.code}`);
      if (err.code === 'ECONNREFUSED') {
        console.error(`[Portfolio] Cannot reach Zerion API - check internet connection`);
      }
    }
    res.status(500).json({ 
      success: false, 
      error: err.response?.data || err.message,
      details: {
        status: err.response?.status,
        code: err.code,
      }
    });
  }
});

// GET /api/portfolio/price/:symbol
router.get('/price/:symbol', async (req: Request, res: Response) => {
  try {
    const { symbol } = req.params;
    console.log(`[Portfolio] Fetching price for: ${symbol}`);
    
    const priceData = await getCachedSolPrice();
    const price = priceData?.price ?? 0;
    const change = priceData?.change24h ?? 0;
    console.log(`[Portfolio] Price: $${price}, Change: ${change}%`);
    res.json({ success: true, price, change24h: change });
  } catch (err: any) {
    console.error(`[Portfolio] ❌ Price fetch error: ${err.message}`);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// GET /api/portfolio/balance/:publicKey
// Returns real SOL balance from chain + USD value from Zerion price
router.get('/balance/:publicKey', async (req: Request, res: Response) => {
  try {
    const { publicKey } = req.params;
    console.log(`[Portfolio] Fetching balance for: ${publicKey}`);
    
    const connection = new Connection(
      process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );
    const pubkey = new PublicKey(publicKey);

    // SOL balance
    console.log(`[Portfolio] Getting SOL balance...`);
    const lamports = await connection.getBalance(pubkey);
    const sol = lamports / LAMPORTS_PER_SOL;
    console.log(`[Portfolio] SOL balance: ${sol}`);

    // USDC balance
    let usdc = 0;
    try {
      console.log(`[Portfolio] Getting USDC balance...`);
      const ata = await getAssociatedTokenAddress(USDC_MINT, pubkey);
      const tokenAccount = await getAccount(connection, ata);
      usdc = Number(tokenAccount.amount) / 1_000_000; // USDC has 6 decimals
      console.log(`[Portfolio] USDC balance: ${usdc}`);
    } catch (err: any) {
      console.log(`[Portfolio] No USDC account found (OK): ${err.message}`);
      usdc = 0;
    }

    // SOL price from Zerion (cached, falls back to 0 if rate limited)
    const priceData = await getCachedSolPrice();
    const price = priceData?.price ?? 0;
    const change24h = priceData?.change24h ?? 0;
    const totalUsd = (sol * price) + usdc;
    if (price) console.log(`[Portfolio] SOL price: $${price}, 24h change: ${change24h}%`);

    res.json({ success: true, sol, usdc, usd: totalUsd, price, change24h });
  } catch (err: any) {
    const errorMsg = err.response?.data?.error || err.message || JSON.stringify(err).slice(0, 200);
    console.error(`[Portfolio] ❌ Balance fetch error: ${errorMsg}`);
    
    // More detailed error logging
    console.error(`[Portfolio] Error details:`, {
      status: err.response?.status,
      statusText: err.response?.statusText,
      message: err.message,
      code: err.code,
      url: err.config?.url,
      headers: err.config?.headers ? `${Object.keys(err.config.headers).join(', ')}` : 'none',
    });
    
    if (err.response?.status === 401 || err.response?.status === 403) {
      console.error('[Portfolio] Auth error - check ZERION_API_KEY in .env');
    }
    if (err.response?.status === 429) {
      console.error('[Portfolio] Rate limited by Zerion API - wait before retrying');
    }
    if (err.code === 'ECONNREFUSED') {
      console.error('[Portfolio] Cannot connect to Zerion API - check internet connection');
    }
    
    res.status(500).json({ success: false, error: errorMsg });
  }
});

export default router;