# Sentra Swap Module Setup & Troubleshooting Guide

## Overview
This guide helps you get the Zerion CLI swap module working with Sentra on WSL/Ubuntu.

## ✅ Prerequisites (WSL/Ubuntu)

### 1. Node.js & npm
```bash
# Check your versions (should be Node 20+)
node --version  # v20.x or later
npm --version   # 10.x or later
```

### 2. Dependencies Installed
```bash
# From project root
npm install

# Verify @open-wallet-standard/core is installed with Linux binary
ls -la node_modules/@open-wallet-standard/core-linux-x64-gnu/

# You should see a .node binary file
```

### 3. Environment Variables
```bash
# In .env file at project root
ZERION_API_KEY=your_api_key_here
SOLANA_RPC=https://api.mainnet-beta.solana.com  # or your custom RPC
PORT=3001
```

---

## 🚀 Quick Start: Test the Swap Module

### Option A: Run the Unit Test
```bash
cd /path/to/Sentra
node --test tests/unit/zerion-swap-module.test.mjs
```

**Expected Output:**
```
✓ can dynamically import cli/lib/trading/swap.js
✓ exports getSwapQuote function
✓ getSwapQuote returns expected quote structure
✓ transaction.data can be deserialized as Solana transaction
```

### Option B: Test Directly in Node REPL
```bash
node --input-type=module

# Inside REPL:
const swap = await import('./cli/lib/trading/swap.js');
console.log(typeof swap.getSwapQuote); // Should print "function"

// Test a real quote
const quote = await swap.getSwapQuote({
  fromToken: 'USDC',
  toToken: 'SOL',
  amount: '1',
  fromChain: 'solana',
  toChain: 'solana',
  walletAddress: 'So11111111111111111111111111111111111111112',
});

console.log(quote.transaction.data); // Should print hex string
```

---

## 🔍 Common Issues & Solutions

### Issue 1: "Cannot find module '@open-wallet-standard/core-win32-x64-msvc'"
**Cause:** Running on Windows (not WSL)  
**Solution:** Use WSL2 or Ubuntu environment

```bash
# Check if running on WSL
wsl --version  # Windows command (outside WSL)
# If this works, you're on Windows — open WSL terminal instead
```

### Issue 2: "Cannot find module '../../cli/lib/trading/swap.js'"
**Cause:** Incorrect import path in TypeScript context  
**Solution:** The path is relative from `server/agents/swap.ts`:
- `../../` goes up to project root
- `cli/lib/trading/swap.js` is correct

```bash
# Verify the file exists
ls -la cli/lib/trading/swap.js  # From project root
```

### Issue 3: "ZERION_API_KEY environment variable not set"
**Solution:** Add to `.env` file:
```
ZERION_API_KEY=your_api_key_here
```

Then reload your terminal or use:
```bash
export ZERION_API_KEY=your_api_key_here
npm run server
```

### Issue 4: "No swap route found"
**Cause:** Invalid amount, token, or no liquidity  
**Solution:**
- Use correct symbols: `USDC`, `SOL`, `ETH`, etc.
- Use minimum amount of ~$1.00
- Check wallet has sufficient balance

```bash
# Test with a proper request
node -e "
const swap = await import('./cli/lib/trading/swap.js');
const quote = await swap.getSwapQuote({
  fromToken: 'USDC',
  toToken: 'SOL',
  amount: '1',
  fromChain: 'solana',
  toChain: 'solana',
  walletAddress: 'Your_Solana_Public_Key_Here'
});
console.log(JSON.stringify(quote, null, 2));
"
```

### Issue 5: "Transaction deserialization failed"
**Cause:** Transaction data is corrupted or in unexpected format  
**Solution:** The code handles both VersionedTransaction and legacy formats automatically. If both fail:

```bash
# Check the hex data is valid
node -e "
const hex = 'your_hex_data_here';
const buf = Buffer.from(hex, 'hex');
console.log('Bytes:', buf.length);
console.log('First 10 bytes:', buf.slice(0, 10).toString('hex'));
"
```

---

## 🧪 Integration Testing

### Test 1: Module Load Test
```bash
# Verify the module can be imported from server context
cd server
node --eval "
import('../agents/swap.ts').then(mod => {
  console.log('✅ swap.ts imports successfully');
}).catch(err => {
  console.error('❌', err.message);
});
"
```

### Test 2: Quote Generation Test
Create file `test-quote.mjs`:
```javascript
import { config } from 'dotenv';
config();

const swap = await import('./cli/lib/trading/swap.js');

try {
  const quote = await swap.getSwapQuote({
    fromToken: 'USDC',
    toToken: 'SOL',
    amount: '1',
    fromChain: 'solana',
    toChain: 'solana',
    walletAddress: 'So11111111111111111111111111111111111111112',
  });

  console.log('✅ Quote received');
  console.log('Amount out:', quote.estimatedOutput, quote.to.symbol);
  console.log('Transaction data length:', quote.transaction.data.length);
  console.log('Liquidity source:', quote.liquiditySource);
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exit(1);
}
```

Run it:
```bash
node test-quote.mjs
```

### Test 3: Transaction Signing Test
Create file `test-sign.mjs`:
```javascript
import { Keypair, VersionedTransaction, Transaction } from '@solana/web3.js';
import { config } from 'dotenv';
config();

const swap = await import('./cli/lib/trading/swap.js');

try {
  // Get a quote
  const quote = await swap.getSwapQuote({
    fromToken: 'USDC',
    toToken: 'SOL',
    amount: '1',
    fromChain: 'solana',
    toChain: 'solana',
    walletAddress: 'Your_Wallet_Address',
  });

  // Decode transaction
  const txBuffer = Buffer.from(quote.transaction.data, 'hex');

  // Try versioned first
  let tx;
  try {
    tx = VersionedTransaction.deserialize(txBuffer);
    console.log('✅ Transaction is VersionedTransaction (v0+)');
  } catch {
    tx = Transaction.from(txBuffer);
    console.log('✅ Transaction is legacy format');
  }

  console.log('✅ Transaction deserialized successfully');
  console.log('Instructions:', tx.instructions?.length || 'N/A');

  // Create test keypair (DO NOT use for real funds)
  const testKeypair = Keypair.generate();
  console.log('Test keypair created:', testKeypair.publicKey.toBase58());

  // Sign with test keypair
  if (tx instanceof VersionedTransaction) {
    tx.sign([testKeypair]);
  } else {
    tx.partialSign(testKeypair);
  }
  console.log('✅ Transaction signed successfully');

} catch (err) {
  console.error('❌ Error:', err.message);
  process.exit(1);
}
```

Run it:
```bash
node test-sign.mjs
```

---

## 📋 Deployment Checklist

Before deploying to production:

- [ ] Running on Linux/WSL (not Windows)
- [ ] `npm install` completed successfully
- [ ] ZERION_API_KEY is set in `.env`
- [ ] SOLANA_RPC is configured (or using default)
- [ ] Swap module test passes: `node --test tests/unit/zerion-swap-module.test.mjs`
- [ ] Server starts: `npm run server`
- [ ] No console errors about missing modules
- [ ] Can successfully call `executeZerionSwap()` from server/agents/dca.ts

---

## 🔗 Key Files

- **Swap execution:** [server/agents/swap.ts](../../server/agents/swap.ts)
- **Zerion swap module:** [cli/lib/trading/swap.js](../../cli/lib/trading/swap.js)
- **DCA agent (uses swap):** [server/agents/dca.ts](../../server/agents/dca.ts)
- **Tests:** [tests/unit/zerion-swap-module.test.mjs](../../tests/unit/zerion-swap-module.test.mjs)

---

## 🆘 Still Having Issues?

1. **Check the full error message** — Copy the entire error stack
2. **Verify .env file** — Is ZERION_API_KEY set correctly?
3. **Check Node/npm versions** — Run `node --version` and `npm --version`
4. **Try the test files** — Run the test scripts to isolate the issue
5. **Check Zerion API status** — Can you reach `https://api.zerion.io`?

---

## ✨ What's Working

✅ Dynamic import of `cli/lib/trading/swap.js`  
✅ `getSwapQuote()` function available and working  
✅ Quote structure includes `transaction.data` as hex string  
✅ Transaction deserialization (both v0+ and legacy formats)  
✅ Signing with Solana keypair  
✅ Broadcasting via Solana RPC  
✅ Enhanced error messages and debugging info
