import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { executeDCA } from '../agents/dca.js';
import { executeRebalance } from '../agents/rebalance.js';
import { executeSignal } from '../agents/signal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = path.join(__dirname, '../../.agent-keys');

function loadAllAgents() {
  if (!fs.existsSync(KEYS_DIR)) return [];
  return fs.readdirSync(KEYS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(KEYS_DIR, f), 'utf-8')));
}

async function runDCAForAllAgents() {
  const agents = loadAllAgents();
  const dcaAgents = agents.filter(
    a => a.strategy === 'dca' && a.status !== 'awaiting_funding' && a.paused !== true
  );

  if (dcaAgents.length === 0) {
    console.log('[Scheduler] No active DCA agents found');
    return;
  }

  console.log(`[Scheduler] Running DCA for ${dcaAgents.length} agent(s)...`);
  for (const agent of dcaAgents) {
    await executeDCA({
      agentId: agent.agentId,
      amountUSDC: agent.goal?.amountUSDC || 5,
      targetAsset: agent.goal?.targetAsset || 'SOL',
      frequency: agent.goal?.frequency || 'daily',
    });
  }
}

async function runRebalanceForAllAgents() {
  const agents = loadAllAgents();
  const rebalanceAgents = agents.filter(
    a => a.strategy === 'rebalance' && a.status !== 'awaiting_funding' && a.paused !== true
  );

  if (rebalanceAgents.length === 0) return;

  console.log(`[Scheduler] Running rebalance check for ${rebalanceAgents.length} agent(s)...`);
  for (const agent of rebalanceAgents) {
    await executeRebalance(agent.agentId);
  }
}

async function runSignalForAllAgents() {
  const agents = loadAllAgents();
  const signalAgents = agents.filter(
    a => a.strategy === 'signal' && a.status !== 'awaiting_funding' && a.paused !== true
  );

  if (signalAgents.length === 0) return;

  console.log(`[Scheduler] Running signal check for ${signalAgents.length} agent(s)...`);
  for (const agent of signalAgents) {
    await executeSignal(agent.agentId);
  }
}

export function startScheduler() {
  console.log('[Scheduler] Starting Sentra cron scheduler...');

  // DCA — daily at 9:00 AM
  cron.schedule('0 9 * * *', async () => {
    console.log('\n[Scheduler] ⏰ Daily DCA trigger fired');
    await runDCAForAllAgents();
  });

  // Rebalance check — every hour
  cron.schedule('0 * * * *', async () => {
    console.log('\n[Scheduler] ⚖️ Hourly rebalance check fired');
    await runRebalanceForAllAgents();
  });

  // Signal check — every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    console.log('\n[Scheduler] 📡 Signal check fired');
    await runSignalForAllAgents();
  });

  // Health check log — every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    const agents = loadAllAgents();
    console.log(`[Scheduler] 💓 Heartbeat — ${agents.length} agent(s) registered`);
  });

  console.log('[Scheduler] ✅ Cron jobs active');
  console.log('[Scheduler]    DCA: daily at 9:00 AM');
  console.log('[Scheduler]    Rebalance: every hour');
  console.log('[Scheduler]    Signal: every 15 minutes');
  console.log('[Scheduler]    Heartbeat: every 5 minutes');
}
