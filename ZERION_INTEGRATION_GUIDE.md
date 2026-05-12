# Sentra Zerion Swap Integration - Implementation Guide

## Overview
This document covers the complete Zerion CLI swap module integration in Sentra, showing how it flows from DCA agent → swap execution → Zerion API → transaction signing → Solana broadcast.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Sentra Architecture                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Cron Job (daily 9AM)                                      │
│       ↓                                                     │
│  server/cron/scheduler.ts                                  │
│       ↓                                                     │
│  executeDCA() — server/agents/dca.ts                       │
│       ├─ Load agent keypair                                │
│       ├─ Check 4 policy gates                              │
│       ├─ Validate wallet ready (SOL + USDC)                │
│       ↓                                                     │
│  executeZerionSwap() — server/agents/swap.ts               │
│       │                                                    │
│       ├─ Import cli/lib/trading/swap.js                    │
│       ├─ Call getSwapQuote()                               │
│       │    ↓ (inside Zerion CLI)                           │
│       │    ├─ Resolve token IDs (USDC, SOL)                │
│       │    ├─ Call Zerion API: /swap/offers/               │
│       │    ├─ Get best quote with transaction.data (hex)   │
│       │    └─ Return quote object                          │
│       │                                                    │
│       ├─ Parse quote.transaction.data (hex)                │
│       ├─ Deserialize Solana transaction                    │
│       ├─ Sign with agent keypair                           │
│       └─ Broadcast via Solana RPC                          │
│                ↓                                           │
│  Return SwapResult {signature, price, liquiditySource}     │
│                ↓                                           │
│  Log execution result                                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Key Files

### 1. **Swap Execution Engine** — [server/agents/swap.ts](../server/agents/swap.ts)

This file contains the core swap logic:

```typescript
// Main entry point
export async function executeZerionSwap(
  fromSymbol: string,      // e.g., 'USDC'
  toSymbol: string,        // e.g., 'SOL'
  amount: number,          // e.g., 100 (USD)
  keypair: Keypair,        // Agent's signing key
  publicKey: string        // Agent's wallet address
): Promise<SwapResult>
```

**What it does:**
1. Imports `getSwapQuote` from `../../cli/lib/trading/swap.js`
2. Calls `getSwapQuote()` to get routing + transaction from Zerion API
3. Deserializes the hex-encoded Solana transaction
4. Signs with agent keypair
5. Broadcasts to Solana network
6. Returns `{signature, price, liquiditySource}`

### 2. **Zerion Swap Module** — [cli/lib/trading/swap.js](../cli/lib/trading/swap.js)

Zerion's swap module (part of the forked CLI) exports:

```javascript
export async function getSwapQuote({
  fromToken,      // 'USDC'
  toToken,        // 'SOL'
  amount,         // '100'
  fromChain,      // 'solana'
  toChain,        // 'solana'
  walletAddress   // '...'
}): Promise<Quote>
```

**What it returns:**
```javascript
{
  id: "quote_id",
  from: {
    symbol: 'USDC',
    decimals: 6,
    fungibleId: '...',
    address: '...'
  },
  to: {
    symbol: 'SOL',
    decimals: 9,
    fungibleId: '11111...',
    address: 'So11111...'
  },
  inputAmount: '100',
  estimatedOutput: 50.123,
  outputMin: 49.999,
  liquiditySource: 'Jupiter',
  preconditions: { enough_balance: true, enough_allowance: true },
  transaction: {
    data: '0x' + 'hex_encoded_serialized_solana_tx',
    to: '...',
    value: '...'
  },
  fee: { protocolAmount: 0.5, ... }
}
```

### 3. **DCA Agent** — [server/agents/dca.ts](../server/agents/dca.ts)

Orchestrates daily DCA execution:

```typescript
export async function executeDCA(config: DCAConfig): Promise<ExecutionResult>
```

**Flow:**
1. Load agent from `.agent-keys/{agentId}.json`
2. Check 4 policy gates (spend cap, daily limit, expiry, wallet ready)
3. Call `executeZerionSwap('USDC', targetAsset, amount, keypair, publicKey)`
4. Log result to `.agent-logs/{agentId}.json`

### 4. **Cron Scheduler** — [server/cron/scheduler.ts](../server/cron/scheduler.ts)

Runs daily at 9 AM:
```typescript
node-cron.schedule('0 9 * * *', async () => {
  const agents = getAllAgents();
  for (const agent of agents) {
    await executeDCA(agent);
  }
});
```

---

## Data Flow: One Complete Swap

### Example: 100 USDC → SOL

```
1. DCA Agent calls:
   executeZerionSwap('USDC', 'SOL', 100, keypair, 'F3u4...')

2. Swap module imports Zerion CLI:
   swapModule = await import('../../cli/lib/trading/swap.js')

3. Calls getSwapQuote:
   {
     fromToken: 'USDC',
     toToken: 'SOL',
     amount: '100',
     fromChain: 'solana',
     toChain: 'solana',
     walletAddress: 'F3u4...'
   }

4. Zerion CLI internally:
   a) Resolves USDC → {fungibleId: '0xa0b86991...', decimals: 6, ...}
   b) Resolves SOL → {fungibleId: '11111111...', decimals: 9, ...}
   c) Converts amount: 100 * 10^6 = 100000000
   d) Calls Zerion API: /swap/offers/?input[from]=F3u4...&input[fungible_id]=0xa0b86991...&...
   e) Gets best route (e.g., Jupiter)
   f) Returns transaction data as hex

5. Back in swap.ts:
   quote.transaction.data = '0xe0...' (hex)
   
6. Deserialize transaction:
   txBuffer = Buffer.from(quote.transaction.data, 'hex')
   tx = VersionedTransaction.deserialize(txBuffer)

7. Sign transaction:
   tx.sign([keypair])

8. Broadcast:
   signature = await sendAndConfirmRawTransaction(connection, rawTx)

9. Return:
   {
     signature: '3Jy...',
     inputAmount: 100,
     outputMint: 'SOL',
     price: 185.50,
     liquiditySource: 'Jupiter'
   }

10. Log result:
    {
      success: true,
      agentId: 'agent_1',
      action: 'dca_executed',
      amount: 100,
      price: 185.50,
      signature: '3Jy...',
      timestamp: '2026-05-03T09:15:32.000Z'
    }
```

---

## Environment Setup

### Required Environment Variables

```bash
# .env file
ZERION_API_KEY=zk_...your_api_key...
SOLANA_RPC=https://api.mainnet-beta.solana.com
PORT=3001
```

### Node/npm Requirements

```bash
node --version  # v20+
npm --version   # 10+
```

### Dependency Chain

```
@open-wallet-standard/core (^1.2.4)
├─ core-linux-x64-gnu/core.node   ← Linux native binary
├─ core-win32-x64-msvc/core.node  ← Windows native binary (DO NOT USE)
└─ @solana/web3.js (^1.98.4)
    └─ Used for transaction signing/broadcasting
```

---

## Testing & Verification

### Quick Test

```bash
# From project root
node verify-swap-module.mjs
```

This runs:
1. Environment check (ZERION_API_KEY, Node version)
2. Native module check (Linux binary presence)
3. Swap module import test
4. Quote generation test (with real Zerion API call)
5. Transaction deserialization test

### Unit Tests

```bash
node --test tests/unit/zerion-swap-module.test.mjs
```

Tests:
- Module import
- getSwapQuote function exists
- Quote structure validation
- Transaction hex format
- Deserialization as both VersionedTransaction and legacy formats

### Manual Testing in Node REPL

```bash
node --input-type=module

# Test module load
const swap = await import('./cli/lib/trading/swap.js');
console.log(typeof swap.getSwapQuote); // 'function'

# Test quote
const quote = await swap.getSwapQuote({
  fromToken: 'USDC',
  toToken: 'SOL',
  amount: '1',
  fromChain: 'solana',
  toChain: 'solana',
  walletAddress: 'So11111111111111111111111111111111111111112'
});

# Check structure
console.log(quote.transaction.data.slice(0, 20)); // Should be hex
console.log(quote.estimatedOutput); // Should be a number

# Test signing
import { VersionedTransaction } = from '@solana/web3.js';
const tx = VersionedTransaction.deserialize(Buffer.from(quote.transaction.data, 'hex'));
console.log(tx instanceof VersionedTransaction); // true
```

---

## Error Handling

### Common Issues & Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `Cannot find module '@open-wallet-standard/core-win32-x64-msvc'` | Running on Windows | Use WSL2 Ubuntu |
| `ZERION_API_KEY not set` | Missing .env | Add `ZERION_API_KEY=...` to .env |
| `No swap route found` | Invalid tokens or low amount | Use USDC/SOL, amount ≥ $1 |
| `Cannot deserialize transaction` | Invalid hex or corrupted data | Verify hex format in quote |
| `insufficient lamports` | Wallet doesn't have SOL for fees | Fund wallet with SOL |
| `Module not found: cli/lib/trading/swap.js` | Wrong import path | Check relative path from file |

### Debug Logging

The updated swap.ts includes detailed logging:

```
[Swap] Loading Zerion CLI swap module...
[Swap] Module loaded ✅
[Swap] Calling getSwapQuote(USDC → SOL, amount: 100)...
[Swap] Quote received ✅ | Route: Jupiter
[Swap] Attempting to deserialize as VersionedTransaction...
[Swap] Signing with VersionedTransaction (v0+)...
[Swap] ✅ Confirmed (VersionedTransaction (v0+))
[Swap] Signature: 3Jy...
[Swap] Explorer: https://explorer.solana.com/tx/3Jy...
```

---

## Deployment Checklist

Before going live:

- [ ] Running on Linux/WSL (not Windows)
- [ ] All dependencies installed: `npm install`
- [ ] ZERION_API_KEY set in .env
- [ ] Verification script passes: `node verify-swap-module.mjs`
- [ ] Can start server: `npm run server`
- [ ] DCA agent can execute test swap
- [ ] Transactions appear on Solana Explorer
- [ ] Logs are clean (no errors or warnings)

---

## Performance Notes

### API Rate Limiting

Zerion API has rate limits. When testing multiple swaps:

```typescript
// Add delay between API calls
await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5 seconds
```

### RPC Timeout

Default RPC timeout is 30 seconds. For slower networks:

```typescript
const connection = new Connection(RPC_URL, 'confirmed');
// Timeout is set in sendAndConfirmRawTransaction options
```

### Quote Validity

Quote transactions are only valid for ~120 seconds. Don't delay between quote request and broadcast.

---

## Zerion API Satisfaction

This implementation satisfies the Zerion Frontier Hackathon requirements:

✅ **"All swaps must route through the Zerion API"**
   - `getSwapQuote()` calls Zerion API's `/swap/offers/` endpoint
   - All routing decisions made by Zerion

✅ **"Use your forked Zerion CLI as the wallet and execution layer"**
   - Direct import from `cli/lib/trading/swap.js`
   - Uses Zerion's quote structure and transaction format
   - We sign and broadcast (own keypair layer)

✅ **"Support Solana"**
   - Full Solana support via @solana/web3.js
   - VersionedTransaction + legacy format support
   - RPC broadcast via Solana mainnet

---

## Future Enhancements

Potential improvements:

1. **Slippage Control** — Add slippage parameter to getSwapQuote
2. **Multi-Hop Routes** — Support cross-chain swaps (if needed)
3. **Liquidity Source Preference** — Let users choose routing DEX
4. **Transaction Simulation** — Dry-run before broadcast
5. **MEV Protection** — Add MEV-protection to swaps
6. **Retry Logic** — Retry failed transactions with fresh quotes
