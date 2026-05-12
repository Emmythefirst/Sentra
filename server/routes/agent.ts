import express from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  Connection, PublicKey, SystemProgram, LAMPORTS_PER_SOL,
  TransactionMessage, VersionedTransaction, sendAndConfirmRawTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress, getAccount,
  createTransferInstruction, createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = process.env.KEYS_DIR ?? path.join(__dirname, '../../.agent-keys');
const LOGS_DIR = process.env.LOGS_DIR ?? path.join(__dirname, '../../.agent-logs');

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SOL_FEE_RESERVE = 5_000; // lamports to keep for fees on SOL withdrawals

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadAgent(agentId: string) {
  const fp = path.join(KEYS_DIR, `${agentId}.json`);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf-8'));
}

function saveAgent(agentId: string, data: any) {
  fs.writeFileSync(path.join(KEYS_DIR, `${agentId}.json`), JSON.stringify(data, null, 2));
}

function getSolanaConnection() {
  return new Connection(
    process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com',
    'confirmed'
  );
}

// Sign a VersionedTransaction we built ourselves via OWS, then broadcast.
async function signAndBroadcastTransfer(
  versionedTx: VersionedTransaction,
  walletName: string,
  passphrase: string,
  fromPubkey: PublicKey,
  connection: Connection
): Promise<string> {
  // @ts-ignore — JS module from forked CLI
  const { signSolanaTransaction } = await import('../../cli/lib/wallet/keystore.js');

  const txBytes = Buffer.from(versionedTx.serialize());
  const signResult = signSolanaTransaction(walletName, txBytes.toString('hex'), passphrase);
  const sigBytes = Buffer.from(signResult.signature, 'hex');

  versionedTx.addSignature(fromPubkey, sigBytes);
  const rawTx = Buffer.from(versionedTx.serialize());

  return sendAndConfirmRawTransaction(connection, rawTx, {
    skipPreflight: false,
    commitment: 'confirmed',
  });
}

// ── GET /api/agent/stats ──────────────────────────────────────────────────────

router.get('/stats', (req: Request, res: Response) => {
  try {
    let agentCount = 0;
    let txCount = 0;

    if (fs.existsSync(KEYS_DIR)) {
      agentCount = fs.readdirSync(KEYS_DIR).filter(f => f.endsWith('.json')).length;
    }

    if (fs.existsSync(LOGS_DIR)) {
      for (const f of fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.json'))) {
        try {
          const logs = JSON.parse(fs.readFileSync(path.join(LOGS_DIR, f), 'utf-8'));
          txCount += logs.filter((l: any) => l.success && l.action?.includes('executed')).length;
        } catch {}
      }
    }

    res.json({ agentCount, txCount });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/agent/create ────────────────────────────────────────────────────

router.post('/create', async (req: Request, res: Response) => {
  try {
    const { name, goal, strategy } = req.body;

    if (!name || !goal || !strategy) {
      res.status(400).json({ success: false, error: 'name, goal and strategy are required' });
      return;
    }

    // @ts-ignore — JS module from forked CLI
    const { createWallet } = await import('../../cli/lib/wallet/keystore.js');

    const agentId = `agent-${Date.now()}`;
    const walletName = agentId;
    const passphrase = crypto.randomBytes(32).toString('hex');

    const wallet = createWallet(walletName, passphrase);

    if (!wallet.solAddress) {
      throw new Error('OWS wallet creation succeeded but no Solana address was returned');
    }

    if (!fs.existsSync(KEYS_DIR)) fs.mkdirSync(KEYS_DIR, { recursive: true });

    const agentData = {
      agentId,
      name,
      goal,
      strategy,
      walletName,
      passphrase,
      solAddress: wallet.solAddress,
      evmAddress: wallet.evmAddress,
      publicKey: wallet.solAddress, // backward-compat alias
      createdAt: new Date().toISOString(),
      status: 'awaiting_funding',
      paused: false,
      policies: {
        maxSpendPerTx: 10,
        dailySpendLimit: 50,
        chainLock: 'solana',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
    };

    saveAgent(agentId, agentData);

    res.json({
      success: true,
      agent: {
        agentId,
        name,
        goal,
        strategy,
        publicKey: agentData.solAddress,
        solAddress: agentData.solAddress,
        evmAddress: agentData.evmAddress,
        createdAt: agentData.createdAt,
        status: agentData.status,
        paused: false,
        policies: agentData.policies,
        explorerUrl: `https://explorer.solana.com/address/${agentData.solAddress}`,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/agent/:agentId ───────────────────────────────────────────────────

router.get('/:agentId', (req: Request, res: Response) => {
  try {
    const { agentId } = req.params as { agentId: string };
    const data = loadAgent(agentId);
    if (!data) { res.status(404).json({ success: false, error: 'Agent not found' }); return; }
    const { passphrase, privateKey, ...safeData } = data;
    res.json({ success: true, agent: safeData });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/agent/:agentId/logs ──────────────────────────────────────────────

router.get('/:agentId/logs', (req: Request, res: Response) => {
  try {
    const { agentId } = req.params as { agentId: string };
    const logFile = path.join(LOGS_DIR, `${agentId}.json`);
    if (!fs.existsSync(logFile)) { res.json({ logs: [] }); return; }
    const logs = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
    res.json({ logs });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/agent/:agentId/configure ───────────────────────────────────────

router.post('/:agentId/configure', (req: Request, res: Response) => {
  try {
    const { agentId } = req.params as { agentId: string };
    const data = loadAgent(agentId);
    if (!data) { res.status(404).json({ success: false, error: 'Agent not found' }); return; }

    const updated = { ...data, ...req.body, status: 'active' };
    updated.passphrase = data.passphrase;
    updated.walletName = data.walletName;

    saveAgent(agentId, updated);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── PATCH /api/agent/:agentId/policies ───────────────────────────────────────

router.patch('/:agentId/policies', (req: Request, res: Response) => {
  try {
    const { agentId } = req.params as { agentId: string };
    const data = loadAgent(agentId);
    if (!data) { res.status(404).json({ success: false, error: 'Agent not found' }); return; }

    data.policies = { ...data.policies, ...req.body };
    saveAgent(agentId, data);
    res.json({ success: true, policies: data.policies });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/agent/:agentId/pause ───────────────────────────────────────────

router.post('/:agentId/pause', (req: Request, res: Response) => {
  try {
    const { agentId } = req.params as { agentId: string };
    const data = loadAgent(agentId);
    if (!data) { res.status(404).json({ success: false, error: 'Agent not found' }); return; }
    data.paused = true;
    saveAgent(agentId, data);
    res.json({ success: true, paused: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/agent/:agentId/resume ──────────────────────────────────────────

router.post('/:agentId/resume', (req: Request, res: Response) => {
  try {
    const { agentId } = req.params as { agentId: string };
    const data = loadAgent(agentId);
    if (!data) { res.status(404).json({ success: false, error: 'Agent not found' }); return; }
    data.paused = false;
    saveAgent(agentId, data);
    res.json({ success: true, paused: false });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/agent/:agentId/withdraw ────────────────────────────────────────
// Body: { asset: 'SOL' | 'USDC' | 'ALL', amount?: number, destination: string }

router.post('/:agentId/withdraw', async (req: Request, res: Response) => {
  try {
    const { agentId } = req.params as { agentId: string };
    const { asset = 'SOL', amount, destination } = req.body;

    if (!destination) {
      res.status(400).json({ success: false, error: 'destination address is required' });
      return;
    }

    const data = loadAgent(agentId);
    if (!data) { res.status(404).json({ success: false, error: 'Agent not found' }); return; }

    const { walletName, passphrase, solAddress } = data;
    if (!walletName || !passphrase || !solAddress) {
      res.status(400).json({ success: false, error: 'Agent wallet not configured' });
      return;
    }

    const connection = getSolanaConnection();
    const fromPubkey = new PublicKey(solAddress);
    const toPubkey = new PublicKey(destination);
    const signatures: { asset: string; signature: string }[] = [];

    // ── SOL transfer ──────────────────────────────────────────────────────────
    if (asset === 'SOL' || asset === 'ALL') {
      const balance = await connection.getBalance(fromPubkey);
      const lamports = amount !== undefined && asset === 'SOL'
        ? BigInt(Math.floor(amount * LAMPORTS_PER_SOL))
        : BigInt(Math.max(0, balance - SOL_FEE_RESERVE));

      if (lamports > 0n) {
        const { blockhash } = await connection.getLatestBlockhash();
        const versionedTx = new VersionedTransaction(
          new TransactionMessage({
            payerKey: fromPubkey,
            recentBlockhash: blockhash,
            instructions: [SystemProgram.transfer({ fromPubkey, toPubkey, lamports })],
          }).compileToV0Message()
        );
        const sig = await signAndBroadcastTransfer(versionedTx, walletName, passphrase, fromPubkey, connection);
        signatures.push({ asset: 'SOL', signature: sig });
      }
    }

    // ── USDC transfer ─────────────────────────────────────────────────────────
    if (asset === 'USDC' || asset === 'ALL') {
      const sourceAta = await getAssociatedTokenAddress(USDC_MINT, fromPubkey);
      const destAta = await getAssociatedTokenAddress(USDC_MINT, toPubkey);

      let tokenBalance: bigint;
      try {
        const tokenAccount = await getAccount(connection, sourceAta);
        tokenBalance = tokenAccount.amount;
      } catch {
        if (asset === 'USDC') {
          res.status(400).json({ success: false, error: 'No USDC token account found on agent wallet' });
          return;
        }
        tokenBalance = 0n;
      }

      const usdcAmount = amount !== undefined && asset === 'USDC'
        ? BigInt(Math.floor(amount * 1_000_000))
        : tokenBalance;

      if (usdcAmount > 0n) {
        const instructions = [];

        // Create destination ATA if it doesn't exist
        try {
          await getAccount(connection, destAta);
        } catch {
          instructions.push(
            createAssociatedTokenAccountInstruction(fromPubkey, destAta, toPubkey, USDC_MINT)
          );
        }
        instructions.push(createTransferInstruction(sourceAta, destAta, fromPubkey, usdcAmount));

        const { blockhash } = await connection.getLatestBlockhash();
        const versionedTx = new VersionedTransaction(
          new TransactionMessage({
            payerKey: fromPubkey,
            recentBlockhash: blockhash,
            instructions,
          }).compileToV0Message()
        );
        const sig = await signAndBroadcastTransfer(versionedTx, walletName, passphrase, fromPubkey, connection);
        signatures.push({ asset: 'USDC', signature: sig });
      }
    }

    res.json({ success: true, signatures });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/agent/:agentId/trigger ─────────────────────────────────────────

router.post('/:agentId/trigger', async (req: Request, res: Response) => {
  try {
    const { agentId } = req.params as { agentId: string };
    const data = loadAgent(agentId);
    if (!data) { res.status(404).json({ success: false, error: 'Agent not found' }); return; }

    if (data.paused) {
      res.json({
        success: false,
        agentId,
        action: 'trigger_blocked',
        reason: 'Agent is paused. Resume it before triggering.',
      });
      return;
    }

    let result: any;
    if (data.strategy === 'dca') {
      const { executeDCA } = await import('../agents/dca.js');
      result = await executeDCA({
        agentId,
        amountUSDC: data.goal?.amountUSDC || 5,
        targetAsset: data.goal?.targetAsset || 'SOL',
        frequency: data.goal?.frequency || 'daily',
      });
    } else if (data.strategy === 'rebalance') {
      const { executeRebalance } = await import('../agents/rebalance.js');
      result = await executeRebalance(agentId);
    } else if (data.strategy === 'signal') {
      const { executeSignal } = await import('../agents/signal.js');
      result = await executeSignal(agentId);
    } else {
      result = { success: false, agentId, action: 'unknown_strategy', reason: `Unknown strategy: ${data.strategy}` };
    }

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/agent/:agentId/run-dca (legacy) ────────────────────────────────

router.post('/:agentId/run-dca', async (req: Request, res: Response) => {
  try {
    const { agentId } = req.params as { agentId: string };
    const { amountUSDC = 5, targetAsset = 'SOL', frequency = 'daily' } = req.body;
    const { executeDCA } = await import('../agents/dca.js');
    const result = await executeDCA({ agentId, amountUSDC, targetAsset, frequency });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
