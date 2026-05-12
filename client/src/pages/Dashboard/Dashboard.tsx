import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Area, AreaChart, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import axios from 'axios';
import './Dashboard.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

interface LogEntry {
  timestamp: string;
  action: string;
  success: boolean;
  reason?: string;
  blockedBy?: string;
  amount?: number;
  price?: number;
  signature?: string;
}

interface Agent {
  agentId: string;
  name: string;
  strategy: string;
  publicKey: string;
  solAddress?: string;
  walletName?: string;
  paused?: boolean;
  policies: {
    maxSpendPerTx: number;
    dailySpendLimit: number;
    expiresAt: string;
    chainLock: string;
  };
  goal: any;
  status: string;
}

interface Balance {
  sol: number;
  usdc: number;
  usd: number;
  price: number;
  change24h: number;
}

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

function buildChartFromLogs(logs: LogEntry[], currentUsd: number) {
  const executed = logs
    .filter(l => l.success && l.action?.includes('executed'))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  if (executed.length === 0) {
    return Array.from({ length: 6 }, (_, i) => ({ t: i, v: currentUsd || 0, label: '' }));
  }

  const totalSpent = executed.reduce((s, l) => s + (l.amount || 0), 0);
  const baseVal = Math.max(0, currentUsd - totalSpent * 0.05);
  const step = (currentUsd - baseVal) / executed.length;

  const points = executed.map((log, i) => ({
    t: i,
    v: baseVal + step * (i + 1),
    label: new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  }));

  points.unshift({ t: -1, v: baseVal, label: 'Start' });
  points.push({ t: points.length, v: currentUsd, label: 'Now' });
  return points;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function strategyLabel(s: string) {
  if (s === 'dca') return 'Dollar Cost Average';
  if (s === 'rebalance') return 'Portfolio Rebalance';
  if (s === 'signal') return 'Buy the Dip';
  return s;
}

function strategyDesc(agent: Agent) {
  if (agent.strategy === 'dca') {
    return `Buy $${agent.goal?.amountUSDC || 5} USDC → SOL · ${agent.goal?.frequency || 'daily'}`;
  }
  if (agent.strategy === 'rebalance') {
    const a = agent.goal?.allocations;
    return `${a?.SOL || 60}% SOL / ${a?.USDC || 40}% USDC · >${agent.goal?.driftThreshold || 5}% drift`;
  }
  return `Buy $${agent.goal?.amountUSDC || 5} USDC on ≥${agent.goal?.signalDrop || 5}% drop`;
}

function daysRemaining(expiresAt: string) {
  const diff = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

function getLogMessage(log: LogEntry): { main: string; sub?: string } {
  if (log.success) {
    if (log.action === 'dca_executed') return {
      main: `DCA executed · $${log.amount} USDC → SOL at $${log.price?.toFixed(2)}`,
      sub: log.signature ? `${log.signature.slice(0, 22)}…` : undefined,
    };
    if (log.action === 'rebalance_executed') return {
      main: `Rebalance executed · $${log.amount?.toFixed(2)} swap`,
      sub: log.signature ? `${log.signature.slice(0, 22)}…` : undefined,
    };
    if (log.action === 'signal_executed') return {
      main: `Signal buy · $${log.amount} USDC → SOL at $${log.price?.toFixed(2)}`,
      sub: log.signature ? `${log.signature.slice(0, 22)}…` : undefined,
    };
    if (log.action === 'signal_watching') return { main: `Signal watching · ${log.reason || ''}` };
    if (log.action === 'rebalance_checked') return { main: 'Portfolio checked · within threshold' };
    if (log.action === 'dca_skipped') return { main: 'DCA skipped · wallet not funded' };
    return { main: log.action };
  }

  if (log.action?.includes('blocked')) return {
    main: `${log.blockedBy || 'Policy'} · Action blocked`,
    sub: log.reason,
  };

  if (log.action === 'signal_blocked') return {
    main: `Signal blocked · ${log.blockedBy || 'Policy'}`,
    sub: log.reason,
  };

  const raw = log.reason || '';
  if (raw.includes('Insufficient SOL')) return { main: 'Blocked · Insufficient SOL for fees' };
  if (raw.includes('Insufficient USDC')) return { main: 'Blocked · Insufficient USDC balance' };
  if (raw.includes('Too many requests') || raw.includes('throttled')) return { main: 'Rate limited · Retrying next cycle' };
  if (raw.includes('Simulation failed')) return { main: 'Simulation failed · Retrying' };
  if (raw.includes('blockhash not found')) return { main: 'Transaction stale · Requesting new quote' };
  if (raw.includes('insufficient lamports')) return { main: 'Insufficient SOL for fees · Please top up' };
  return { main: 'Error · Retrying next cycle', sub: raw.slice(0, 100) };
}

export default function Dashboard() {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [txCount, setTxCount] = useState(0);
  const [totalDcad, setTotalDcad] = useState(0);
  const [triggering, setTriggering] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);
  const [addrCopied, setAddrCopied] = useState(false);

  // Funding modal state
  const [showFunding, setShowFunding] = useState(false);

  // Withdraw modal state
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawAsset, setWithdrawAsset] = useState<'SOL' | 'USDC' | 'ALL'>('ALL');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawDest, setWithdrawDest] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);

  // Edit guardrails modal
  const [showEdit, setShowEdit] = useState(false);
  const [editMaxTx, setEditMaxTx] = useState(0);
  const [editDailyLimit, setEditDailyLimit] = useState(0);
  const [editExpiry, setEditExpiry] = useState<7 | 14 | 30>(7);
  const [savingPolicies, setSavingPolicies] = useState(false);

  // Reset confirm
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const solAddress = agent?.solAddress ?? agent?.publicKey ?? '';

  useEffect(() => {
    loadAll();
  }, [agentId]);

  useEffect(() => {
    if (!solAddress) return;
    fetchBalance(solAddress);
    const interval = setInterval(() => {
      fetchBalance(solAddress);
      loadLogs();
    }, 10000);
    return () => clearInterval(interval);
  }, [solAddress]);

  function showToast(message: string, type: Toast['type'] = 'success') {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4500);
  }

  async function loadAll() {
    await Promise.all([loadAgent(), loadLogs()]);
  }

  async function loadAgent() {
    try {
      const { data } = await axios.get(`${API}/api/agent/${agentId}`);
      setAgent(data.agent);
    } catch {
      showToast('Failed to load agent', 'error');
    }
  }

  async function fetchBalance(addr: string) {
    try {
      const { data } = await axios.get(`${API}/api/portfolio/balance/${addr}`);
      if (data.success) setBalance(data);
    } catch {}
  }

  async function loadLogs() {
    try {
      const { data } = await axios.get(`${API}/api/agent/${agentId}/logs`);
      if (data.logs) {
        const reversed = [...data.logs].reverse();
        setLogs(reversed);
        setTxCount(data.logs.filter((l: LogEntry) => l.success && l.action?.includes('executed')).length);
        setTotalDcad(
          data.logs
            .filter((l: LogEntry) => l.success && l.action?.includes('executed'))
            .reduce((s: number, l: LogEntry) => s + (l.amount || 0), 0)
        );
      }
    } catch {}
  }

  async function triggerAgent() {
    if (agent?.paused) return;
    setTriggering(true);
    try {
      const { data } = await axios.post(`${API}/api/agent/${agentId}/trigger`);
      await loadLogs();
      if (agent?.solAddress || agent?.publicKey) await fetchBalance(solAddress);
      if (data.success) showToast('Agent executed successfully', 'success');
      else if (data.action?.includes('blocked')) showToast(`${data.blockedBy || 'Policy'} blocked the action`, 'error');
      else showToast('Agent cycle complete', 'info');
    } catch {
      showToast('Trigger failed — check server logs', 'error');
    }
    setTriggering(false);
  }

  async function togglePause() {
    if (!agent) return;
    const action = agent.paused ? 'resume' : 'pause';
    try {
      await axios.post(`${API}/api/agent/${agentId}/${action}`);
      setAgent(prev => prev ? { ...prev, paused: !prev.paused } : prev);
      showToast(action === 'pause' ? 'Agent paused' : 'Agent resumed', 'info');
    } catch {
      showToast(`Failed to ${action} agent`, 'error');
    }
  }

  async function doWithdraw() {
    if (!withdrawDest) { showToast('Enter a destination address', 'error'); return; }
    setWithdrawing(true);
    try {
      const body: any = { asset: withdrawAsset, destination: withdrawDest };
      if (withdrawAmount && withdrawAsset !== 'ALL') body.amount = parseFloat(withdrawAmount);
      const { data } = await axios.post(`${API}/api/agent/${agentId}/withdraw`, body);
      if (data.success) {
        showToast(`Withdrawn successfully (${data.signatures?.length} tx)`, 'success');
        setShowWithdraw(false);
        setWithdrawDest('');
        setWithdrawAmount('');
        if (solAddress) fetchBalance(solAddress);
      } else {
        showToast(`Withdrawal failed: ${data.error}`, 'error');
      }
    } catch (err: any) {
      showToast(`Withdrawal error: ${err.response?.data?.error || err.message}`, 'error');
    }
    setWithdrawing(false);
  }

  function openEditGuardrails() {
    if (!agent) return;
    setEditMaxTx(agent.policies?.maxSpendPerTx ?? 10);
    setEditDailyLimit(agent.policies?.dailySpendLimit ?? 50);
    const days = daysRemaining(agent.policies?.expiresAt);
    setEditExpiry(days >= 21 ? 30 : days >= 10 ? 14 : 7);
    setShowEdit(true);
  }

  async function savePolicies() {
    setSavingPolicies(true);
    try {
      await axios.patch(`${API}/api/agent/${agentId}/policies`, {
        maxSpendPerTx: editMaxTx,
        dailySpendLimit: editDailyLimit,
        expiresAt: new Date(Date.now() + editExpiry * 24 * 60 * 60 * 1000).toISOString(),
      });
      await loadAgent();
      setShowEdit(false);
      showToast('Guardrails updated', 'success');
    } catch {
      showToast('Failed to update guardrails', 'error');
    }
    setSavingPolicies(false);
  }

  function copyAddress() {
    navigator.clipboard.writeText(solAddress);
    setAddrCopied(true);
    setTimeout(() => setAddrCopied(false), 2000);
  }

  function confirmReset() {
    const ids: string[] = JSON.parse(localStorage.getItem('sentra_agent_ids') ?? '[]');
    localStorage.setItem('sentra_agent_ids', JSON.stringify(ids.filter(id => id !== agentId)));
    navigate('/agents');
  }

  const chartData = buildChartFromLogs(logs, balance?.usd || 0);
  const funded = (balance?.usdc ?? 0) >= 1 || (balance?.sol ?? 0) >= 0.01;

  if (!agent) {
    return (
      <div className="db-loading">
        <div className="spinner" />
        <p>Loading agent…</p>
      </div>
    );
  }

  return (
    <div className="dashboard">
      {/* Toasts */}
      <div className="toast-stack">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`}>{t.message}</div>
        ))}
      </div>

      {/* Topbar */}
      <div className="db-topbar">
        <div className="db-logo">
          <span className="nav-logo-icon">◈</span>
          <span className="nav-logo-text grotesk">SENTRA</span>
        </div>
        <div className="db-top-right">
          <button className="db-address-btn" onClick={copyAddress} title={solAddress}>
            {solAddress.slice(0, 6)}…{solAddress.slice(-4)}
            <span className="db-addr-copy">{addrCopied ? '✓' : '⧉'}</span>
          </button>
          <div className={`db-status-badge ${agent.paused ? 'paused' : 'active'}`}>
            <span className={agent.paused ? 'pause-dot' : 'live-dot'} />
            {agent.paused ? 'Paused' : 'Active'}
          </div>
          <button className="db-icon-btn" onClick={togglePause} title={agent.paused ? 'Resume agent' : 'Pause agent'}>
            {agent.paused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button className="db-icon-btn" onClick={() => setShowWithdraw(true)}>⬆ Withdraw</button>
          <button className="db-reset" onClick={() => setShowResetConfirm(true)}>Disconnect</button>
          <button className="db-exit" onClick={() => navigate('/agents')}>← Agents</button>
        </div>
      </div>

      {/* Paused banner */}
      {agent.paused && (
        <div className="paused-banner">
          ⏸ Agent is paused — no transactions will execute until you resume it.
          <button className="paused-banner-btn" onClick={togglePause}>Resume now</button>
        </div>
      )}

      {/* Funding warning */}
      {!funded && balance !== null && (
        <div className="funding-banner">
          ⚠ Wallet needs funding before the agent can execute trades.
          <button className="funding-banner-link" onClick={() => setShowFunding(true)}>
            View instructions →
          </button>
        </div>
      )}

      <div className="db-layout">
        {/* Left sidebar */}
        <div className="db-sidebar">
          <div className="sidebar-section">
            <span className="sidebar-label">STRATEGY</span>
            <div className="strategy-box">
              <span className="strategy-box-name">{strategyLabel(agent.strategy)}</span>
              <span className="strategy-box-desc">{strategyDesc(agent)}</span>
            </div>
          </div>

          <div className="sidebar-section">
            <div className="sidebar-section-header">
              <span className="sidebar-label">GUARDRAILS</span>
              <button className="edit-btn" onClick={openEditGuardrails}>Edit</button>
            </div>
            <div className="guardrail-list">
              <div className="guardrail-row">
                <span>Max per tx</span>
                <span>${agent.policies?.maxSpendPerTx ?? '—'}</span>
              </div>
              <div className="guardrail-row">
                <span>Daily limit</span>
                <span>${agent.policies?.dailySpendLimit ?? '—'}</span>
              </div>
              <div className="guardrail-row">
                <span>Expiry</span>
                <span>{agent.policies?.expiresAt ? `${daysRemaining(agent.policies.expiresAt)}d` : '—'}</span>
              </div>
              <div className="guardrail-row">
                <span>Chain</span>
                <span className="chain-tag">⬡ {agent.policies?.chainLock || 'Solana'}</span>
              </div>
            </div>
          </div>

          <div className="sidebar-section">
            <span className="sidebar-label">SOL PRICE</span>
            <div className="sol-price">
              {balance ? `$${balance.price.toFixed(2)}` : '—'}
            </div>
            {balance && (
              <span className={`sol-change ${balance.change24h >= 0 ? 'positive' : 'negative'}`}>
                {balance.change24h >= 0 ? '+' : ''}{balance.change24h.toFixed(2)}% 24h
              </span>
            )}
            <span className="sol-source">Zerion price feed</span>
          </div>

          {agent.strategy === 'dca' && (
            <div className="sidebar-section">
              <span className="sidebar-label">NEXT DCA</span>
              <div className="next-exec-box">
                <span className="next-exec-label">{agent.goal?.frequency || 'Daily'}</span>
                <span className="next-exec-sub">at 9:00 AM UTC</span>
              </div>
            </div>
          )}

          <div className="sidebar-section sidebar-section-last">
            <span className="sidebar-label">TOTAL DCA'D</span>
            <div className="total-dcad">${totalDcad.toFixed(2)} USDC</div>
            <span className="total-dcad-sub">across {txCount} trade{txCount !== 1 ? 's' : ''}</span>
          </div>
        </div>

        {/* Main */}
        <div className="db-main">
          <div className="portfolio-header">
            <span className="portfolio-label">PORTFOLIO VALUE</span>
            <div className="portfolio-value grotesk">
              {balance ? `$${balance.usd.toFixed(2)}` : '—'}
            </div>
            <div className="balance-row">
              <span className="balance-chip">
                <span className="balance-chip-label">SOL</span>
                {balance ? balance.sol.toFixed(4) : '—'}
              </span>
              <span className="balance-chip">
                <span className="balance-chip-label">USDC</span>
                {balance ? `$${balance.usdc.toFixed(2)}` : '—'}
              </span>
              <span className="balance-chip">
                <span className="balance-chip-label">PRICE</span>
                {balance ? `$${balance.price.toFixed(2)}` : '—'}/SOL
              </span>
            </div>
          </div>

          <div className="chart-card">
            <div className="chart-top">
              <div className="chart-title-row">
                <span className="chart-title">Value history</span>
                <span className="chart-badge">Indicative</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={chartData} margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#00e5b4" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#00e5b4" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="label" hide />
                <YAxis hide domain={['auto', 'auto']} />
                <Tooltip
                  contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', fontSize: '12px' }}
                  formatter={(v: any) => [`$${Number(v).toFixed(2)}`, 'Value']}
                  labelFormatter={(label) => label || ''}
                />
                <Area type="monotone" dataKey="v" stroke="#00e5b4" strokeWidth={2} fill="url(#grad)" dot={false} activeDot={{ r: 4, fill: '#00e5b4' }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="stat-cards">
            <div className="stat-card-item">
              <span className="stat-card-num grotesk" style={{ color: 'var(--accent)' }}>{txCount}</span>
              <span className="stat-card-label">Trades executed</span>
            </div>
            <div className="stat-card-item">
              <span className="stat-card-num grotesk">${totalDcad.toFixed(2)}</span>
              <span className="stat-card-label">Total traded</span>
            </div>
            <div className="stat-card-item">
              <span className="stat-card-num grotesk">
                {agent.policies?.expiresAt ? daysRemaining(agent.policies.expiresAt) : '—'}
              </span>
              <span className="stat-card-label">Days remaining</span>
            </div>
          </div>

          <div className="trigger-section">
            <button
              className="trigger-btn"
              onClick={triggerAgent}
              disabled={triggering || !!agent.paused}
              title={agent.paused ? 'Resume the agent to trigger manually' : ''}
            >
              {triggering ? <><span className="btn-spinner-dark" /> Executing…</> : '⚡ Trigger Agent Now'}
            </button>
            {agent.paused && (
              <span className="trigger-hint">Agent is paused — resume to trigger</span>
            )}
            {!agent.paused && (
              <span className="trigger-hint">Test your strategy outside the cron schedule</span>
            )}
          </div>
        </div>

        {/* Log sidebar */}
        <div className="db-log-sidebar">
          <div className="log-header">
            <span className="log-title">Agent Log</span>
            <span className="live-dot" />
          </div>

          <div className="log-list">
            {logs.length === 0 && (
              <>
                <div className="log-entry">
                  <span className="log-time">—</span>
                  <div className="log-body">
                    <span className="log-main success">Agent initialised · Strategy loaded</span>
                    <span className="log-sub">{strategyLabel(agent.strategy)} · Zerion API ready</span>
                  </div>
                </div>
                <div className="log-entry">
                  <span className="log-time">—</span>
                  <div className="log-body">
                    <span className="log-main success">Guardrails active</span>
                    <span className="log-sub">
                      ${agent.policies?.maxSpendPerTx}/tx · ${agent.policies?.dailySpendLimit}/day · {agent.policies?.expiresAt ? `${daysRemaining(agent.policies.expiresAt)}d expiry` : ''}
                    </span>
                  </div>
                </div>
              </>
            )}

            {logs.map((log, i) => {
              const { main, sub } = getLogMessage(log);
              return (
                <div key={i} className="log-entry">
                  <span className="log-time">{formatTime(log.timestamp)}</span>
                  <div className="log-body">
                    <span className={`log-main ${log.success ? 'success' : 'blocked'}`}>{main}</span>
                    {log.success && log.signature && (
                      <a
                        href={`https://explorer.solana.com/tx/${log.signature}`}
                        target="_blank"
                        rel="noreferrer"
                        className="log-link"
                      >
                        {log.signature.slice(0, 20)}… ↗
                      </a>
                    )}
                    {!log.success && sub && !sub.includes('{') && (
                      <span className="log-sub">{sub}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="db-footer">
        <span>Swap routing &amp; wallet by <a href="https://zerion.io" target="_blank" rel="noreferrer" className="footer-link">Zerion</a></span>
        <span className="footer-sep">·</span>
        <span>Execution on Solana mainnet</span>
        <span className="footer-sep">·</span>
        <span>Non-custodial · OWS key management</span>
      </footer>

      {/* Withdraw Modal */}
      {showWithdraw && (
        <div className="modal-overlay" onClick={() => setShowWithdraw(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="grotesk">Withdraw Funds</h3>
              <button className="modal-close" onClick={() => setShowWithdraw(false)}>✕</button>
            </div>

            <div className="modal-field">
              <label className="modal-label">ASSET</label>
              <div className="chip-row">
                {(['SOL', 'USDC', 'ALL'] as const).map(a => (
                  <button key={a} className={`chip ${withdrawAsset === a ? 'active' : ''}`} onClick={() => setWithdrawAsset(a)}>
                    {a}
                  </button>
                ))}
              </div>
            </div>

            {withdrawAsset !== 'ALL' && (
              <div className="modal-field">
                <label className="modal-label">AMOUNT (leave blank for full balance)</label>
                <input
                  className="modal-input"
                  type="number"
                  placeholder={`e.g. 0.5`}
                  value={withdrawAmount}
                  onChange={e => setWithdrawAmount(e.target.value)}
                />
              </div>
            )}

            <div className="modal-field">
              <label className="modal-label">DESTINATION ADDRESS</label>
              <input
                className="modal-input"
                type="text"
                placeholder="Solana address"
                value={withdrawDest}
                onChange={e => setWithdrawDest(e.target.value)}
              />
            </div>

            <div className="modal-note">
              Funds will be sent on-chain. This cannot be undone.
            </div>

            <div className="modal-btns">
              <button className="btn-ghost" onClick={() => setShowWithdraw(false)}>Cancel</button>
              <button className="btn-primary btn-danger" onClick={doWithdraw} disabled={withdrawing}>
                {withdrawing ? 'Sending…' : `Withdraw ${withdrawAsset}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Guardrails Modal */}
      {showEdit && (
        <div className="modal-overlay" onClick={() => setShowEdit(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="grotesk">Edit Guardrails</h3>
              <button className="modal-close" onClick={() => setShowEdit(false)}>✕</button>
            </div>

            <div className="modal-field">
              <label className="modal-label">MAX PER TX · ${editMaxTx}</label>
              <input type="range" min={1} max={100} value={editMaxTx} onChange={e => setEditMaxTx(Number(e.target.value))} className="slider" />
            </div>

            <div className="modal-field">
              <label className="modal-label">DAILY LIMIT · ${editDailyLimit}</label>
              <input type="range" min={10} max={500} value={editDailyLimit} onChange={e => setEditDailyLimit(Number(e.target.value))} className="slider" />
            </div>

            <div className="modal-field">
              <label className="modal-label">EXTEND EXPIRY BY</label>
              <div className="chip-row">
                {([7, 14, 30] as const).map(d => (
                  <button key={d} className={`chip ${editExpiry === d ? 'active' : ''}`} onClick={() => setEditExpiry(d)}>
                    {d} days
                  </button>
                ))}
              </div>
            </div>

            <div className="modal-btns">
              <button className="btn-ghost" onClick={() => setShowEdit(false)}>Cancel</button>
              <button className="btn-primary" onClick={savePolicies} disabled={savingPolicies}>
                {savingPolicies ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Funding Modal */}
      {showFunding && (
        <div className="modal-overlay" onClick={() => setShowFunding(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="grotesk">Fund Agent Wallet</h3>
              <button className="modal-close" onClick={() => setShowFunding(false)}>✕</button>
            </div>

            <p className="modal-body-text">
              Send the following to the agent wallet so it can execute trades.
            </p>

            <div className="fund-modal-address">
              <span className="modal-label">AGENT WALLET ADDRESS</span>
              <div className="fund-modal-addr-row">
                <code className="fund-modal-addr-text">{solAddress}</code>
                <button
                  className="fund-modal-copy"
                  onClick={() => {
                    navigator.clipboard.writeText(solAddress);
                    showToast('Address copied', 'success');
                  }}
                >
                  {addrCopied ? '✓' : 'Copy'}
                </button>
              </div>
            </div>

            <div className="fund-modal-steps">
              <div className={`fund-modal-step ${(balance?.sol ?? 0) >= 0.005 ? 'done' : ''}`}>
                <div className="fund-modal-step-num">{(balance?.sol ?? 0) >= 0.005 ? '✓' : '1'}</div>
                <div>
                  <div className="fund-modal-step-title">Send SOL for fees</div>
                  <div className="fund-modal-step-sub">
                    Minimum 0.005 SOL — covers Solana network fees
                    {balance && balance.sol > 0 && (
                      <span className="fund-modal-received"> · {balance.sol.toFixed(5)} SOL received</span>
                    )}
                  </div>
                </div>
              </div>

              <div className={`fund-modal-step ${(balance?.usdc ?? 0) >= 1 ? 'done' : ''}`}>
                <div className="fund-modal-step-num">{(balance?.usdc ?? 0) >= 1 ? '✓' : '2'}</div>
                <div>
                  <div className="fund-modal-step-title">Send USDC for trades</div>
                  <div className="fund-modal-step-sub">
                    Any amount — used as the buy budget for your strategy
                    {balance && balance.usdc > 0 && (
                      <span className="fund-modal-received"> · ${balance.usdc.toFixed(2)} USDC received</span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="fund-modal-note">
              Balance updates every 10 seconds. Close this modal when both steps are checked.
            </div>

            <div className="modal-btns">
              <button className="btn-primary" onClick={() => setShowFunding(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* Reset Confirm Modal */}
      {showResetConfirm && (
        <div className="modal-overlay" onClick={() => setShowResetConfirm(false)}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="grotesk">Disconnect Agent?</h3>
              <button className="modal-close" onClick={() => setShowResetConfirm(false)}>✕</button>
            </div>
            <p className="modal-body-text">
              This will disconnect your browser from this agent. Your wallet and all funds remain safe on-chain. You can reconnect by creating a new agent.
            </p>
            <div className="modal-btns">
              <button className="btn-ghost" onClick={() => setShowResetConfirm(false)}>Keep Agent</button>
              <button className="btn-primary btn-danger" onClick={confirmReset}>Disconnect</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
