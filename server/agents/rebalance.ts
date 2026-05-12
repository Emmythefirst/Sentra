import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';
import { executeZerionSwap, zerionAuth } from './swap.js';
import type { ExecutionResult } from './dca.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = process.env.KEYS_DIR ?? path.join(__dirname, '../../.agent-keys');
const LOGS_DIR = process.env.LOGS_DIR ?? path.join(__dirname, '../../.agent-logs');

function loadAgent(agentId: string) {
  const filePath = path.join(KEYS_DIR, `${agentId}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`Agent ${agentId} not found`);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
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

async function getPortfolio(solAddress: string) {
  const response = await axios.get(
    `https://api.zerion.io/v1/wallets/${solAddress}/positions/?filter[chain_id]=solana`,
    { headers: { Authorization: zerionAuth() } }
  );
  return response.data.data || [];
}

function calculateAllocations(positions: any[]) {
  const totalValue = positions.reduce((sum: number, p: any) =>
    sum + (p.attributes?.value?.usd || 0), 0);

  return positions.map((p: any) => ({
    symbol: p.attributes?.fungible_info?.symbol || 'UNKNOWN',
    valueUSD: p.attributes?.value?.usd || 0,
    percentage: totalValue > 0
      ? ((p.attributes?.value?.usd || 0) / totalValue) * 100
      : 0,
  }));
}

export async function executeRebalance(agentId: string): Promise<ExecutionResult> {
  const timestamp = new Date().toISOString();

  try {
    const agent = loadAgent(agentId);

    if (agent.status === 'awaiting_funding') {
      return {
        success: false, agentId, action: 'rebalance_skipped',
        reason: 'Agent wallet not yet funded', timestamp,
      };
    }

    const targetAllocations: Record<string, number> = agent.goal?.allocations || {
      SOL: 60, USDC: 40,
    };
    const driftThreshold = agent.goal?.driftThreshold || 5;

    // Fetch portfolio from Zerion API
    const positions = await getPortfolio(agent.solAddress ?? agent.publicKey);
    if (!positions || positions.length === 0) {
      const result: ExecutionResult = {
        success: false, agentId, action: 'rebalance_skipped',
        reason: 'No positions found — wallet may not be funded', timestamp,
      };
      logResult(agentId, result);
      return result;
    }

    const current = calculateAllocations(positions);
    console.log(`[Rebalance] ${agentId} — Current allocations (via Zerion API):`);
    current.forEach((p: any) => console.log(`  ${p.symbol}: ${p.percentage.toFixed(1)}% ($${p.valueUSD.toFixed(2)})`));

    // Find assets that need rebalancing
    const rebalanceNeeded = current.filter((p: any) => {
      const target = targetAllocations[p.symbol] || 0;
      return Math.abs(p.percentage - target) > driftThreshold;
    });

    if (rebalanceNeeded.length === 0) {
      console.log(`[Rebalance] ✅ Portfolio within ${driftThreshold}% threshold — no action needed`);
      const result: ExecutionResult = {
        success: true, agentId, action: 'rebalance_checked',
        reason: `All assets within ${driftThreshold}% drift threshold`, timestamp,
      };
      logResult(agentId, result);
      return result;
    }

    const rebalanceAsset = rebalanceNeeded[0];
    const target = targetAllocations[rebalanceAsset.symbol] || 0;
    const drift = rebalanceAsset.percentage - target;
    const amountToSwap = Math.abs((drift / 100) * rebalanceAsset.valueUSD);

    // Policy check — Gate 1
    const policies = agent.policies;
    if (amountToSwap > policies.maxSpendPerTx) {
      console.warn(`[Rebalance] ❌ Gate 1 FAILED — $${amountToSwap.toFixed(2)} exceeds cap`);
      const result: ExecutionResult = {
        success: false, agentId, action: 'rebalance_blocked',
        blockedBy: 'Gate 1 — Spend Cap',
        reason: `Rebalance amount $${amountToSwap.toFixed(2)} exceeds max per-tx of $${policies.maxSpendPerTx}`,
        timestamp,
      };
      logResult(agentId, result);
      return result;
    }

    const fromSymbol = drift > 0 ? rebalanceAsset.symbol : 'USDC';
    const toSymbol = drift > 0 ? 'USDC' : rebalanceAsset.symbol;

    console.log(`[Rebalance] ✅ Gates passed — swapping ${fromSymbol} → ${toSymbol} ($${amountToSwap.toFixed(2)}) via Zerion CLI`);

    const solAddress = agent.solAddress ?? agent.publicKey;
    const swapResult = await executeZerionSwap(
      agent.walletName, agent.passphrase, solAddress,
      fromSymbol, toSymbol, amountToSwap
    );

    const result: ExecutionResult = {
      success: true, agentId, action: 'rebalance_executed',
      amount: amountToSwap, signature: swapResult.signature,
      reason: `${rebalanceAsset.symbol} drifted ${drift.toFixed(1)}% from target ${target}% · Route: ${swapResult.liquiditySource}`,
      timestamp,
    };

    logResult(agentId, result);
    console.log(`[Rebalance] ✅ Rebalanced | Route: ${swapResult.liquiditySource} | Sig: ${swapResult.signature}`);
    return result;

  } catch (err: any) {
    const result: ExecutionResult = {
      success: false, agentId, action: 'rebalance_error',
      reason: err.response?.data ? JSON.stringify(err.response.data) : err.message,
      timestamp,
    };
    logResult(agentId, result);
    return result;
  }
}