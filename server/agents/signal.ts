import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import dotenv from 'dotenv';
import { executeZerionSwap, getSolPrice, zerionAuth } from './swap.js';
import type { ExecutionResult } from './dca.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = process.env.KEYS_DIR ?? path.join(__dirname, '../../.agent-keys');
const LOGS_DIR = process.env.LOGS_DIR ?? path.join(__dirname, '../../.agent-logs');

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

function loadAgent(agentId: string) {
  const filePath = path.join(KEYS_DIR, `${agentId}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`Agent ${agentId} not found`);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function saveAgent(agentId: string, data: any) {
  fs.writeFileSync(path.join(KEYS_DIR, `${agentId}.json`), JSON.stringify(data, null, 2));
}

function logResult(agentId: string, result: ExecutionResult) {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logFile = path.join(LOGS_DIR, `${agentId}.json`);
  const logs: ExecutionResult[] = fs.existsSync(logFile)
    ? JSON.parse(fs.readFileSync(logFile, 'utf-8'))
    : [];
  logs.push(result);
  fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
}

async function checkWalletReadiness(
  publicKey: string,
  amountUSDC: number
): Promise<{ ready: boolean; reason?: string; sol?: number; usdc?: number }> {
  const connection = new Connection(
    process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com',
    'confirmed'
  );

  const lamports = await connection.getBalance(new PublicKey(publicKey));
  const sol = lamports / LAMPORTS_PER_SOL;
  if (sol < 0.005) {
    return { ready: false, sol, reason: `Insufficient SOL for fees: have ${sol.toFixed(5)} SOL, need at least 0.005 SOL` };
  }

  try {
    const ata = await getAssociatedTokenAddress(USDC_MINT, new PublicKey(publicKey));
    const tokenAccount = await getAccount(connection, ata);
    const usdc = Number(tokenAccount.amount) / 1_000_000;
    if (usdc < amountUSDC) {
      return { ready: false, sol, usdc, reason: `Insufficient USDC: have $${usdc.toFixed(2)}, need $${amountUSDC}` };
    }
    return { ready: true, sol, usdc };
  } catch {
    return { ready: false, sol, usdc: 0, reason: 'No USDC token account found. Fund wallet with USDC first.' };
  }
}

function getTodaySpend(agentId: string): number {
  const logFile = path.join(LOGS_DIR, `${agentId}.json`);
  if (!fs.existsSync(logFile)) return 0;
  const logs: ExecutionResult[] = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
  const today = new Date().toDateString();
  return logs
    .filter(l => l.success && new Date(l.timestamp).toDateString() === today)
    .reduce((sum, l) => sum + (l.amount || 0), 0);
}

function checkPolicies(agent: any, amountUSDC: number): { allowed: boolean; reason?: string; gate?: string } {
  const { policies } = agent;
  const now = new Date();

  if (amountUSDC > policies.maxSpendPerTx) {
    return { allowed: false, gate: 'Gate 1 — Spend Cap', reason: `$${amountUSDC} exceeds max per-tx limit of $${policies.maxSpendPerTx}` };
  }

  const todaySpend = getTodaySpend(agent.agentId);
  if (todaySpend + amountUSDC > policies.dailySpendLimit) {
    return { allowed: false, gate: 'Gate 2 — Daily Limit', reason: `Daily limit reached. Spent $${todaySpend} of $${policies.dailySpendLimit}` };
  }

  if (policies.expiresAt && new Date(policies.expiresAt) < now) {
    return { allowed: false, gate: 'Gate 3 — Expiry', reason: `Agent policy expired at ${policies.expiresAt}` };
  }

  return { allowed: true };
}

export async function executeSignal(agentId: string): Promise<ExecutionResult> {
  const timestamp = new Date().toISOString();

  try {
    const agent = loadAgent(agentId);

    if (agent.status === 'awaiting_funding') {
      const result: ExecutionResult = {
        success: false, agentId, action: 'signal_skipped',
        reason: 'Agent wallet not yet funded', timestamp,
      };
      logResult(agentId, result);
      return result;
    }

    const targetAsset: string = agent.goal?.targetAsset || 'SOL';
    const amountUSDC: number = agent.goal?.amountUSDC || 5;
    const signalDrop: number = agent.goal?.signalDrop || 3; // % drop to trigger buy

    const currentPrice = await getSolPrice();
    console.log(`[Signal] ${agentId} — ${targetAsset} price: $${currentPrice.toFixed(2)}`);

    // Initialise reference price on first run
    if (!agent.signalReferencePrice) {
      agent.signalReferencePrice = currentPrice;
      saveAgent(agentId, agent);
      console.log(`[Signal] Reference price set to $${currentPrice.toFixed(2)}`);
      const result: ExecutionResult = {
        success: true, agentId, action: 'signal_watching',
        price: currentPrice,
        reason: `Reference price initialised at $${currentPrice.toFixed(2)}. Watching for ${signalDrop}% drop.`,
        timestamp,
      };
      logResult(agentId, result);
      return result;
    }

    const refPrice: number = agent.signalReferencePrice;
    const dropPct = ((refPrice - currentPrice) / refPrice) * 100;

    console.log(`[Signal] Ref: $${refPrice.toFixed(2)} | Current: $${currentPrice.toFixed(2)} | Drop: ${dropPct.toFixed(2)}%`);

    if (dropPct < signalDrop) {
      const result: ExecutionResult = {
        success: true, agentId, action: 'signal_watching',
        price: currentPrice,
        reason: `Drop ${dropPct.toFixed(2)}% < threshold ${signalDrop}% — holding`,
        timestamp,
      };
      logResult(agentId, result);
      return result;
    }

    console.log(`[Signal] ✅ Drop threshold met (${dropPct.toFixed(2)}% ≥ ${signalDrop}%) — checking gates`);

    // Gate 1, 2, 3
    const policyCheck = checkPolicies(agent, amountUSDC);
    if (!policyCheck.allowed) {
      console.warn(`[Signal] ❌ ${policyCheck.gate} FAILED — ${policyCheck.reason}`);
      const result: ExecutionResult = {
        success: false, agentId, action: 'signal_blocked',
        blockedBy: policyCheck.gate, reason: policyCheck.reason, timestamp,
      };
      logResult(agentId, result);
      return result;
    }

    // Gate 4
    const solAddress = agent.solAddress ?? agent.publicKey;
    const readiness = await checkWalletReadiness(solAddress, amountUSDC);
    if (!readiness.ready) {
      console.warn(`[Signal] ❌ Gate 4 — Wallet Not Ready | ${readiness.reason}`);
      const result: ExecutionResult = {
        success: false, agentId, action: 'signal_blocked',
        blockedBy: 'Gate 4 — Wallet Not Ready', reason: readiness.reason, timestamp,
      };
      logResult(agentId, result);
      return result;
    }

    console.log(`[Signal] ✅ All 4 gates passed — executing buy via Zerion CLI`);

    const swapResult = await executeZerionSwap(
      agent.walletName, agent.passphrase, solAddress,
      'USDC', targetAsset, amountUSDC
    );

    // Reset reference price to current after buy so next signal is relative to new price
    agent.signalReferencePrice = currentPrice;
    saveAgent(agentId, agent);

    const result: ExecutionResult = {
      success: true, agentId, action: 'signal_executed',
      amount: amountUSDC, price: currentPrice,
      signature: swapResult.signature,
      reason: `Bought $${amountUSDC} ${targetAsset} on ${dropPct.toFixed(2)}% drop from $${refPrice.toFixed(2)} · Route: ${swapResult.liquiditySource}`,
      timestamp,
    };

    logResult(agentId, result);
    console.log(`[Signal] ✅ Bought $${amountUSDC} USDC → ${targetAsset} at $${currentPrice.toFixed(2)}`);
    console.log(`[Signal] Route: ${swapResult.liquiditySource}`);
    console.log(`[Signal] Explorer: https://explorer.solana.com/tx/${swapResult.signature}`);
    return result;

  } catch (err: any) {
    const result: ExecutionResult = {
      success: false, agentId, action: 'signal_error',
      reason: err.response?.data ? JSON.stringify(err.response.data) : err.message,
      timestamp,
    };
    logResult(agentId, result);
    return result;
  }
}
