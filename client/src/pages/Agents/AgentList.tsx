import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import './AgentList.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

interface AgentSummary {
  agentId: string;
  name: string;
  strategy: string;
  status: string;
  paused: boolean;
  solAddress: string;
  publicKey: string;
  policies: {
    maxSpendPerTx: number;
    dailySpendLimit: number;
    expiresAt: string;
  };
  goal: any;
  createdAt: string;
}

interface AgentCard extends AgentSummary {
  balance?: { sol: number; usdc: number; usd: number; price: number };
  balanceLoading: boolean;
}

function strategyLabel(s: string) {
  if (s === 'dca') return 'DCA';
  if (s === 'rebalance') return 'Rebalance';
  if (s === 'signal') return 'Buy the Dip';
  if (s === 'pending') return 'Not configured';
  return s;
}

function strategyIcon(s: string) {
  if (s === 'dca') return '📅';
  if (s === 'rebalance') return '⚖️';
  if (s === 'signal') return '📡';
  return '○';
}

function strategyDesc(agent: AgentSummary) {
  if (agent.strategy === 'dca') return `$${agent.goal?.amountUSDC || 5} USDC → SOL · ${agent.goal?.frequency || 'daily'}`;
  if (agent.strategy === 'rebalance') {
    const a = agent.goal?.allocations;
    return `${a?.SOL || 60}% SOL / ${a?.USDC || 40}% USDC`;
  }
  if (agent.strategy === 'signal') return `Buy on ≥${agent.goal?.signalDrop || 5}% drop`;
  return 'Set strategy to activate';
}

function daysRemaining(expiresAt: string) {
  const diff = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

function getStoredIds(): string[] {
  try {
    // Migrate from old single-agent key
    const legacy = localStorage.getItem('sentra_agent_id');
    if (legacy) {
      const ids: string[] = JSON.parse(localStorage.getItem('sentra_agent_ids') ?? '[]');
      if (!ids.includes(legacy)) ids.push(legacy);
      localStorage.setItem('sentra_agent_ids', JSON.stringify(ids));
      localStorage.removeItem('sentra_agent_id');
    }
    return JSON.parse(localStorage.getItem('sentra_agent_ids') ?? '[]');
  } catch {
    return [];
  }
}

export default function AgentList() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentCard[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadAgents();
  }, []);

  async function loadAgents() {
    setLoading(true);
    const ids = getStoredIds();
    if (ids.length === 0) {
      setLoading(false);
      return;
    }

    // Fetch all agent metadata in parallel
    const results = await Promise.allSettled(
      ids.map(id => axios.get(`${API}/api/agent/${id}`))
    );

    const cards: AgentCard[] = results
      .map((r) => {
        if (r.status === 'fulfilled' && r.value.data.success) {
          return { ...r.value.data.agent, balanceLoading: true } as AgentCard;
        }
        return null;
      })
      .filter(Boolean) as AgentCard[];

    setAgents(cards);
    setLoading(false);

    // Fetch balances in parallel (non-blocking)
    cards.forEach((agent, i) => {
      const addr = agent.solAddress ?? agent.publicKey;
      if (!addr) return;
      axios.get(`${API}/api/portfolio/balance/${addr}`)
        .then(r => {
          if (r.data.success) {
            setAgents(prev => prev.map((a, j) =>
              j === i ? { ...a, balance: r.data, balanceLoading: false } : a
            ));
          } else {
            setAgents(prev => prev.map((a, j) =>
              j === i ? { ...a, balanceLoading: false } : a
            ));
          }
        })
        .catch(() => {
          setAgents(prev => prev.map((a, j) =>
            j === i ? { ...a, balanceLoading: false } : a
          ));
        });
    });
  }

  return (
    <div className="agent-list-page dot-grid">
      {/* Nav */}
      <nav className="al-nav">
        <div className="nav-logo" onClick={() => navigate('/')} style={{ cursor: 'pointer' }}>
          <span className="nav-logo-icon">◈</span>
          <span className="nav-logo-text grotesk">SENTRA</span>
        </div>
        <button className="btn-new-agent" onClick={() => navigate('/setup')}>
          + New Agent
        </button>
      </nav>

      <div className="al-body">
        <div className="al-header">
          <h1 className="al-title grotesk">My Agents</h1>
          <span className="al-count">{agents.length} agent{agents.length !== 1 ? 's' : ''}</span>
        </div>

        {loading ? (
          <div className="al-loading">
            <div className="spinner" />
            <p>Loading agents…</p>
          </div>
        ) : agents.length === 0 ? (
          <div className="al-empty">
            <div className="al-empty-icon">◈</div>
            <h3 className="grotesk">No agents yet</h3>
            <p>Create your first autonomous trading agent to get started.</p>
            <button className="btn-hero-primary" onClick={() => navigate('/setup')}>
              Create Agent →
            </button>
          </div>
        ) : (
          <div className="al-grid">
            {agents.map(agent => {
              const addr = agent.solAddress ?? agent.publicKey;
              const expired = agent.policies?.expiresAt
                ? daysRemaining(agent.policies.expiresAt) === 0
                : false;

              let statusLabel = 'Active';
              let statusClass = 'status-active';
              if (agent.status === 'awaiting_funding') { statusLabel = 'Awaiting funding'; statusClass = 'status-pending'; }
              else if (agent.paused) { statusLabel = 'Paused'; statusClass = 'status-paused'; }
              else if (expired) { statusLabel = 'Expired'; statusClass = 'status-expired'; }
              else if (agent.strategy === 'pending') { statusLabel = 'Not configured'; statusClass = 'status-pending'; }

              return (
                <div key={agent.agentId} className="agent-card" onClick={() => navigate(`/dashboard/${agent.agentId}`)}>
                  <div className="ac-top">
                    <div className="ac-strategy-icon">{strategyIcon(agent.strategy)}</div>
                    <div className={`ac-status ${statusClass}`}>{statusLabel}</div>
                  </div>

                  <div className="ac-balance">
                    {agent.balanceLoading ? (
                      <span className="ac-bal-loading">—</span>
                    ) : agent.balance ? (
                      <>
                        <span className="ac-bal-usd grotesk">${agent.balance.usd.toFixed(2)}</span>
                        <span className="ac-bal-detail">{agent.balance.sol.toFixed(4)} SOL · ${agent.balance.usdc.toFixed(2)} USDC</span>
                      </>
                    ) : (
                      <span className="ac-bal-usd grotesk">—</span>
                    )}
                  </div>

                  <div className="ac-info">
                    <div className="ac-strategy-badge">{strategyLabel(agent.strategy)}</div>
                    <div className="ac-strategy-desc">{strategyDesc(agent)}</div>
                  </div>

                  <div className="ac-footer">
                    <span className="ac-addr" title={addr}>
                      {addr.slice(0, 6)}…{addr.slice(-4)}
                    </span>
                    {agent.policies?.expiresAt && !expired && (
                      <span className="ac-expiry">{daysRemaining(agent.policies.expiresAt)}d left</span>
                    )}
                  </div>

                  <div className="ac-open">Open →</div>
                </div>
              );
            })}

            {/* New agent card */}
            <div className="agent-card agent-card-new" onClick={() => navigate('/setup')}>
              <div className="ac-new-icon">+</div>
              <span className="ac-new-label">New Agent</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
