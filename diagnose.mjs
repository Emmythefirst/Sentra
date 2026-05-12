#!/usr/bin/env node
/**
 * Quick diagnostic to identify what's failing
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(__filename);

console.log('\n=== QUICK DIAGNOSTICS ===\n');

// 1. Check .env
console.log('1️⃣  .env file:');
const envPath = join(ROOT, '.env');
console.log(`   Path: ${envPath}`);
console.log(`   Exists: ${existsSync(envPath)}`);

// 2. Load env
const result = config({ path: envPath });
console.log(`\n2️⃣  Loading .env:`);
console.log(`   Loaded successfully: ${!result.error}`);
if (result.error) {
  console.log(`   Error: ${result.error.message}`);
}

// 3. Check ZERION_API_KEY
console.log(`\n3️⃣  Environment variables:`);
console.log(`   ZERION_API_KEY set: ${!!process.env.ZERION_API_KEY}`);
if (process.env.ZERION_API_KEY) {
  console.log(`   Value: ${process.env.ZERION_API_KEY.slice(0, 10)}...${process.env.ZERION_API_KEY.slice(-4)}`);
}

// 4. Check native module
console.log(`\n4️⃣  Native module (@open-wallet-standard/core):`);
const coreDir = join(ROOT, 'node_modules/@open-wallet-standard/core');
const linuxNative = join(ROOT, 'node_modules/@open-wallet-standard/core-linux-x64-gnu/core.node');
console.log(`   core-linux-x64-gnu exists: ${existsSync(linuxNative)}`);
console.log(`   core directory exists: ${existsSync(coreDir)}`);

// 5. Try importing @open-wallet-standard/core
console.log(`\n5️⃣  Trying to import @open-wallet-standard/core:`);
try {
  const ows = await import('@open-wallet-standard/core');
  console.log(`   ✅ Import successful`);
} catch (err) {
  console.log(`   ❌ Import failed: ${err.message}`);
}

// 6. Try importing swap module
console.log(`\n6️⃣  Trying to import cli/lib/trading/swap.js:`);
try {
  const swapPath = join(ROOT, 'cli/lib/trading/swap.js');
  console.log(`   Path: ${swapPath}`);
  console.log(`   Exists: ${existsSync(swapPath)}`);
  const swap = await import(`file://${swapPath}`);
  console.log(`   ✅ Import successful`);
  console.log(`   getSwapQuote exists: ${!!swap.getSwapQuote}`);
} catch (err) {
  console.log(`   ❌ Import failed: ${err.message}`);
}

console.log('\n=== END DIAGNOSTICS ===\n');
