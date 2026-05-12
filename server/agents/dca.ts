import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import dotenv from 'dotenv';
import { executeZerionSwap, getSolPrice, zerionAuth } from './swap.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = process.env.KEYS_DIR ?? path.join(__dirname, '../../.agent-keys');
const LOGS_DIR = process.env.LOGS_DIR ?? path.join(__dirname, '../../.agent-logs');

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

export interface DCAConfig {
  agentId: string;
  amountUSDC: number;
  targetAsset: string;
  frequency: string;
}

export interface ExecutionResult {
  success: boolean;
  agentId: string;
  action: string;
  amount?: number;
  price?: number;
  signature?: string;
  blockedBy?: string;
  reason?: string;
  timestamp: string;
}

function loadAgent(agentId: string) {
  const filePath = path.join(KEYS_DIR, `${agentId}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`Agent ${agentId} not found`);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
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

function getTodaySpend(agentId: string): number {
  const logFile = path.join(LOGS_DIR, `${agentId}.json`);
  if (!fs.existsSync(logFile)) return 0;
  const logs: ExecutionResult[] = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
  const today = new Date().toDateString();
  return logs
    .filter(l => l.success && new Date(l.timestamp).toDateString() === today)
    .reduce((sum, l) => sum + (l.amount || 0), 0);
}

export function logResult(agentId: string, result: ExecutionResult) {
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

export async function executeDCA(config: DCAConfig): Promise<ExecutionResult> {
  const { agentId, amountUSDC, targetAsset } = config;
  const timestamp = new Date().toISOString();

  try {
    const agent = loadAgent(agentId);

    if (agent.status === 'awaiting_funding') {
      const result: ExecutionResult = { success: false, agentId, action: 'dca_skipped', reason: 'Agent wallet not yet funded', timestamp };
      logResult(agentId, result);
      return result;
    }

    const price = await getSolPrice();
    console.log(`[DCA] ${agentId} — SOL price: $${price.toFixed(2)} (Zerion)`);

    await new Promise(resolve => setTimeout(resolve, 1500));

    const solAddress = agent.solAddress ?? agent.publicKey;
    const portfolioRes = await axios.get(
      `https://api.zerion.io/v1/wallets/${solAddress}/positions/?filter[chain_id]=solana`,
      { headers: { Authorization: zerionAuth() } }
    );
    const positions = portfolioRes.data.data || [];
    console.log(`[DCA] Zerion portfolio: ${positions.length} position(s)`);

    const policyCheck = checkPolicies(agent, amountUSDC);
    if (!policyCheck.allowed) {
      console.warn(`[DCA] ❌ ${policyCheck.gate} FAILED — ${policyCheck.reason}`);
      const result: ExecutionResult = { success: false, agentId, action: 'dca_blocked', blockedBy: policyCheck.gate, reason: policyCheck.reason, timestamp };
      logResult(agentId, result);
      return result;
    }

    const readiness = await checkWalletReadiness(solAddress, amountUSDC);
    if (!readiness.ready) {
      console.warn(`[DCA] ❌ Gate 4 — Wallet Not Ready | ${readiness.reason}`);
      const result: ExecutionResult = { success: false, agentId, action: 'dca_blocked', blockedBy: 'Gate 4 — Wallet Not Ready', reason: readiness.reason, timestamp };
      logResult(agentId, result);
      return result;
    }

    console.log(`[DCA] ✅ All 4 gates passed — executing via Zerion CLI`);
    console.log(`[DCA] SOL: ${readiness.sol?.toFixed(5)} | USDC: $${readiness.usdc?.toFixed(2)} | Swapping: $${amountUSDC}`);

    const swapResult = await executeZerionSwap(
      agent.walletName, agent.passphrase, solAddress,
      'USDC', targetAsset, amountUSDC
    );

    const result: ExecutionResult = {
      success: true, agentId, action: 'dca_executed',
      amount: amountUSDC, price: swapResult.price,
      signature: swapResult.signature, timestamp,
    };

    logResult(agentId, result);
    console.log(`[DCA] ✅ Swapped $${amountUSDC} USDC → ${targetAsset} at $${swapResult.price.toFixed(2)}`);
    console.log(`[DCA] Route: ${swapResult.liquiditySource}`);
    console.log(`[DCA] Explorer: https://explorer.solana.com/tx/${swapResult.signature}`);
    return result;

  } catch (err: any) {
    const result: ExecutionResult = {
      success: false, agentId, action: 'dca_error',
      reason: err.response?.data ? JSON.stringify(err.response.data) : err.message,
      timestamp,
    };
    logResult(agentId, result);
    return result;
  }
}
