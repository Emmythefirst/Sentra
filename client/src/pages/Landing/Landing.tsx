import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './Landing.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export default function Landing() {
  const navigate = useNavigate();
  const hasAgents = (() => {
    try { return JSON.parse(localStorage.getItem('sentra_agent_ids') ?? '[]').length > 0; }
    catch { return false; }
  })();
  const [stats, setStats] = useState<{ agentCount: number; txCount: number } | null>(null);

  useEffect(() => {
    fetch(`${API}/api/agent/stats`)
      .then(r => r.json())
      .then(d => setStats(d))
      .catch(() => {});
  }, []);

  function handleCTA() {
    if (hasAgents) {
      navigate('/agents');
    } else {
      navigate('/setup');
    }
  }

  return (
    <div className="landing dot-grid">
      {/* Nav */}
      <nav className="landing-nav">
        <div className="nav-logo">
          <span className="nav-logo-icon">◈</span>
          <span className="nav-logo-text grotesk">SENTRA</span>
        </div>
        <div className="nav-right">
          <span className="nav-badge">⬡ Solana mainnet</span>
          <a className="nav-link" href="https://github.com/zeriontech/zerion-wallet-extension" target="_blank" rel="noreferrer">Docs</a>
          <button className="nav-cta" onClick={handleCTA}>
            {hasAgents ? 'My Agents' : 'Launch App'}
          </button>
        </div>
      </nav>

      {/* Hero */}
      <div className="hero">
        <div className="live-pill">
          <span className="live-dot" />
          Agent execution live on Solana mainnet
        </div>

        <h1 className="hero-headline grotesk">
          Set the rules.<br />
          <span className="hero-accent">Walk away.</span>
        </h1>

        <p className="hero-sub">
          Sentra runs an autonomous on-chain agent that executes real
          Solana transactions within your exact guardrails — no approvals,
          no seed phrase exposure, no babysitting.
        </p>

        <div className="hero-tags hero-tags-top">
          <span className="hero-tag">◈ Non-custodial</span>
          <span className="hero-tag">⬡ Solana mainnet</span>
          <span className="hero-tag">⚡ Powered by Zerion</span>
        </div>

        <div className="hero-btns">
          <button className="btn-hero-primary" onClick={handleCTA}>
            {hasAgents ? 'My Agents →' : 'Create Agent Wallet →'}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="stats-bar">
        <div className="stat-card">
          <span className="stat-num grotesk">{stats ? stats.agentCount : '—'}</span>
          <span className="stat-label">Agents created</span>
        </div>
        <div className="stat-divider" />
        <div className="stat-card">
          <span className="stat-num grotesk" style={{ color: 'var(--accent)' }}>
            {stats ? stats.txCount : '—'}
          </span>
          <span className="stat-label">Txs executed</span>
        </div>
        <div className="stat-divider" />
        <div className="stat-card">
          <span className="stat-num grotesk" style={{ color: 'var(--accent)' }}>Mainnet</span>
          <span className="stat-label">Real on-chain trades</span>
        </div>
      </div>

      {/* How it works */}
      <section className="section" id="how">
        <h2 className="section-title grotesk">How it works</h2>
        <div className="steps-row">
          <div className="step-card">
            <span className="step-num grotesk">01</span>
            <h3 className="step-title">Create an agent wallet</h3>
            <p className="step-desc">An isolated OWS wallet is generated for your agent. Your keys never leave the encrypted keystore.</p>
          </div>
          <div className="step-arrow">→</div>
          <div className="step-card">
            <span className="step-num grotesk">02</span>
            <h3 className="step-title">Set your guardrails</h3>
            <p className="step-desc">Define spend caps, daily limits, and expiry. The agent is policy-bound — it cannot exceed what you allow.</p>
          </div>
          <div className="step-arrow">→</div>
          <div className="step-card">
            <span className="step-num grotesk">03</span>
            <h3 className="step-title">Fund &amp; launch</h3>
            <p className="step-desc">Send USDC to the agent wallet. It starts executing your strategy automatically — no further input needed.</p>
          </div>
        </div>
      </section>

      {/* Strategies */}
      <section className="section" id="strategies">
        <h2 className="section-title grotesk">Strategies</h2>
        <div className="strategy-grid">
          <div className="strategy-card">
            <div className="strategy-icon">📅</div>
            <h3 className="strategy-name">DCA</h3>
            <p className="strategy-desc">Buy a fixed USDC amount of SOL (or any token) on a daily schedule. Smooth out market volatility automatically.</p>
          </div>
          <div className="strategy-card">
            <div className="strategy-icon">⚖️</div>
            <h3 className="strategy-name">Rebalance</h3>
            <p className="strategy-desc">Keep your SOL/USDC split within a target band. The agent rebalances hourly when drift exceeds your threshold.</p>
          </div>
          <div className="strategy-card">
            <div className="strategy-icon">📡</div>
            <h3 className="strategy-name">Signal</h3>
            <p className="strategy-desc">Buy the dip. The agent monitors price every 15 minutes and buys when the drop hits your trigger percentage.</p>
          </div>
        </div>
      </section>

      {/* Security */}
      <section className="section" id="security">
        <h2 className="section-title grotesk">Security model</h2>
        <div className="security-grid">
          <div className="security-item">
            <span className="security-icon">🔒</span>
            <div>
              <h4 className="security-title">No raw key exposure</h4>
              <p className="security-desc">All signing is done via OWS (Open Wallet Standard). The agent never sees your private key.</p>
            </div>
          </div>
          <div className="security-item">
            <span className="security-icon">🛡️</span>
            <div>
              <h4 className="security-title">Policy-gated execution</h4>
              <p className="security-desc">Every transaction passes 4 gates: spend cap, daily limit, expiry, and wallet readiness — in sequence.</p>
            </div>
          </div>
          <div className="security-item">
            <span className="security-icon">⏸️</span>
            <div>
              <h4 className="security-title">Pause any time</h4>
              <p className="security-desc">One click pauses the agent. It stops executing immediately and resumes only when you say so.</p>
            </div>
          </div>
          <div className="security-item">
            <span className="security-icon">🏦</span>
            <div>
              <h4 className="security-title">Withdraw on demand</h4>
              <p className="security-desc">Pull SOL, USDC, or all funds back to any wallet address at any time — no delay, no friction.</p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="cta-section">
        <h2 className="cta-title grotesk">Ready to deploy your agent?</h2>
        <p className="cta-sub">Takes 2 minutes. Real mainnet execution. You stay in control.</p>
        <button className="btn-hero-primary btn-cta-large" onClick={handleCTA}>
          {hasAgents ? 'My Agents →' : 'Create Agent Wallet →'}
        </button>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="footer-left">
          <span className="nav-logo-icon">◈</span>
          <span className="footer-brand grotesk">SENTRA</span>
          <span className="footer-divider">·</span>
          <span className="footer-note">Swap routing &amp; wallet infrastructure by <a href="https://zerion.io" target="_blank" rel="noreferrer" className="footer-link">Zerion</a></span>
        </div>
        <div className="footer-right">
          <a href="https://github.com/zeriontech" target="_blank" rel="noreferrer" className="footer-link">GitHub</a>
        </div>
      </footer>
    </div>
  );
}
