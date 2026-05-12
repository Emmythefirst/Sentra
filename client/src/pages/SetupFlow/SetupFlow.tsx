import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import './SetupFlow.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

type Step = 1 | 2 | 3;

interface BalanceState {
  sol: number;
  usdc: number;
}

export default function SetupFlow() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(1);
  const [agent, setAgent] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [balance, setBalance] = useState<BalanceState>({ sol: 0, usdc: 0 });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Policy state
  const [maxSpendPerTx, setMaxSpendPerTx] = useState(25);
  const [dailyLimit, setDailyLimit] = useState(100);
  const [expiry, setExpiry] = useState<7 | 14 | 30>(7);

  // Goal state
  const [strategy, setStrategy] = useState<'dca' | 'rebalance' | 'signal'>('dca');
  const [dcaAmount, setDcaAmount] = useState(5);
  const [dcaSchedule, setDcaSchedule] = useState('Every day');
  const [solTarget, setSolTarget] = useState(60);
  const [driftThreshold, setDriftThreshold] = useState(5);
  const [signalDrop, setSignalDrop] = useState(5);
  const [signalAmount, setSignalAmount] = useState(5);

  // No auto-create on mount — user triggers it explicitly to avoid orphaned wallets

  // Poll balance from chain when on step 1 and we have an address
  useEffect(() => {
    if (!agent?.solAddress || step !== 1) return;

    function poll() {
      fetch(`${API}/api/portfolio/balance/${agent.solAddress}`)
        .then(r => r.json())
        .then(d => {
          if (d.success) setBalance({ sol: d.sol ?? 0, usdc: d.usdc ?? 0 });
        })
        .catch(() => {});
    }

    poll();
    pollRef.current = setInterval(poll, 6000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [agent?.solAddress, step]);

  async function createWallet() {
    setCreating(true);
    try {
      const { data } = await axios.post(`${API}/api/agent/create`, {
        name: 'Sentra Agent',
        goal: {},
        strategy: 'pending',
        policies: {},
      });
      setAgent(data.agent);
      const ids: string[] = JSON.parse(localStorage.getItem('sentra_agent_ids') ?? '[]');
      if (!ids.includes(data.agent.agentId)) ids.push(data.agent.agentId);
      localStorage.setItem('sentra_agent_ids', JSON.stringify(ids));
    } catch (err) {
      console.error('Failed to create wallet', err);
    }
    setCreating(false);
  }

  function copyAddress() {
    if (!agent) return;
    navigator.clipboard.writeText(agent.solAddress ?? agent.publicKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function launchAgent() {
    if (!agent || launching) return;
    setLaunching(true);
    try {
      await axios.post(`${API}/api/agent/${agent.agentId}/configure`, {
        strategy,
        goal: strategy === 'dca'
          ? { amountUSDC: dcaAmount, targetAsset: 'SOL', frequency: dcaSchedule }
          : strategy === 'rebalance'
          ? { allocations: { SOL: solTarget, USDC: 100 - solTarget }, driftThreshold }
          : { amountUSDC: signalAmount, targetAsset: 'SOL', signalDrop },
        policies: {
          maxSpendPerTx,
          dailySpendLimit: dailyLimit,
          chainLock: 'solana',
          expiresAt: new Date(Date.now() + expiry * 24 * 60 * 60 * 1000).toISOString(),
        },
      });
      navigate(`/agents`);
    } catch (err) {
      console.error('Failed to launch agent', err);
      setLaunching(false);
    }
  }

  const solFunded = balance.sol >= 0.005;
  const usdcFunded = balance.usdc >= 1;
  const address = agent?.solAddress ?? agent?.publicKey ?? '';

  const steps = [
    { n: 1, label: 'Wallet' },
    { n: 2, label: 'Guardrails' },
    { n: 3, label: 'Strategy' },
  ];

  return (
    <div className="setup dot-grid">
      <div className="setup-header">
        <div className="nav-logo" onClick={() => navigate('/')} style={{ cursor: 'pointer' }}>
          <span className="nav-logo-icon">◈</span>
          <span className="nav-logo-text grotesk">SENTRA</span>
        </div>
      </div>

      <div className="stepper">
        {steps.map((s, i) => (
          <div key={s.n} className="step-item">
            <div className={`step-circle ${step > s.n ? 'done' : step === s.n ? 'active' : ''}`}>
              {step > s.n ? '✓' : s.n}
            </div>
            <span className={`step-label ${step === s.n ? 'active' : ''}`}>{s.label}</span>
            {i < steps.length - 1 && (
              <div className={`step-line ${step > s.n ? 'done' : ''}`} />
            )}
          </div>
        ))}
      </div>

      <div className="setup-body">

        {/* Step 1 — Wallet + Fund */}
        {step === 1 && (
          <div className="setup-card">
            {!agent && !creating ? (
              <div className="card-centered">
                <div className="wallet-pre-icon">◈</div>
                <h3 className="wallet-pre-title grotesk">Create Agent Wallet</h3>
                <p className="wallet-pre-desc">
                  A dedicated Solana wallet will be generated for your agent.
                  Keys are secured via OWS — never exposed.
                </p>
                <button className="btn-primary" style={{ width: '100%' }} onClick={createWallet}>
                  Generate Wallet →
                </button>
                <button className="btn-ghost" style={{ width: '100%' }} onClick={() => navigate('/')}>← Back</button>
              </div>
            ) : creating ? (
              <div className="card-centered">
                <div className="spinner" />
                <p className="creating-text">Generating secure agent wallet…</p>
              </div>
            ) : (
              <>
                <div className="wallet-created-header">
                  <div className="check-circle">✓</div>
                  <div>
                    <h3>Agent Wallet Created</h3>
                    <p>Keys secured via OWS · Never exposed</p>
                  </div>
                </div>

                <div className="address-box">
                  <span className="field-label">SOLANA ADDRESS</span>
                  <div className="address-full">{address}</div>
                  <button className="copy-btn-full" onClick={copyAddress}>
                    {copied ? '✓ Copied' : 'Copy address'}
                  </button>
                </div>

                <div className="funding-panel">
                  <div className="funding-panel-title">Fund this wallet to continue</div>
                  <div className="funding-step">
                    <span className={`fund-check ${solFunded ? 'ok' : ''}`}>{solFunded ? '✓' : '○'}</span>
                    <div>
                      <div className="fund-step-label">Send SOL <span className="fund-min">(min 0.005 SOL for fees)</span></div>
                      {balance.sol > 0 && <div className="fund-bal">{balance.sol.toFixed(5)} SOL received</div>}
                    </div>
                  </div>
                  <div className="funding-step">
                    <span className={`fund-check ${usdcFunded ? 'ok' : ''}`}>{usdcFunded ? '✓' : '○'}</span>
                    <div>
                      <div className="fund-step-label">Send USDC <span className="fund-min">(for swaps)</span></div>
                      {balance.usdc > 0 && <div className="fund-bal">${balance.usdc.toFixed(2)} USDC received</div>}
                    </div>
                  </div>
                  {!solFunded && !usdcFunded && (
                    <div className="fund-waiting">
                      <span className="wait-dot" /> Checking wallet every 6 seconds…
                    </div>
                  )}
                </div>

                <div className="step-btns">
                  <button className="btn-ghost" onClick={() => navigate('/')}>← Back</button>
                  <button className="btn-primary" onClick={() => setStep(2)}>
                    Set Guardrails →
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Step 2 — Policies */}
        {step === 2 && (
          <div className="setup-wide">
            <h2 className="grotesk">Set guardrails</h2>
            <p className="step-desc">The agent will never exceed these rules. You can update them anytime from the dashboard.</p>

            <div className="policy-card">
              <div className="policy-row">
                <span className="policy-name">Max spend per transaction</span>
                <span className="policy-value grotesk">${maxSpendPerTx}</span>
              </div>
              <input
                type="range" min={1} max={100}
                value={maxSpendPerTx}
                onChange={e => setMaxSpendPerTx(Number(e.target.value))}
                className="slider"
              />

              <div className="policy-divider" />

              <div className="policy-row">
                <span className="policy-name">Daily spend limit</span>
                <span className="policy-value grotesk">${dailyLimit}</span>
              </div>
              <input
                type="range" min={10} max={500}
                value={dailyLimit}
                onChange={e => setDailyLimit(Number(e.target.value))}
                className="slider"
              />

              <div className="policy-divider" />

              <div className="policy-section">
                <span className="policy-name">Agent expiry</span>
                <div className="chip-row">
                  {([7, 14, 30] as const).map(d => (
                    <button
                      key={d}
                      className={`chip ${expiry === d ? 'active' : ''}`}
                      onClick={() => setExpiry(d)}
                    >
                      {d} days
                    </button>
                  ))}
                </div>
              </div>

              <div className="policy-divider" />

              <div className="policy-row chain-row">
                <div>
                  <span className="policy-name">Chain lock</span>
                  <p className="policy-sub">Transactions restricted to Solana</p>
                </div>
                <div className="chain-badge">⬡ Solana</div>
              </div>
            </div>

            <div className="policy-summary">
              Max ${maxSpendPerTx}/tx · ${dailyLimit}/day · {expiry}d expiry · Solana only
            </div>

            <div className="step-btns wide">
              <button className="btn-ghost" onClick={() => setStep(1)}>← Back</button>
              <button className="btn-primary" onClick={() => setStep(3)}>Choose Strategy →</button>
            </div>
          </div>
        )}

        {/* Step 3 — Strategy + Launch */}
        {step === 3 && (
          <div className="setup-wide">
            <h2 className="grotesk">Choose your strategy</h2>
            <p className="step-desc">The agent executes this autonomously, always within your guardrails.</p>

            <div className="strategy-list">
              <div
                className={`strategy-item ${strategy === 'dca' ? 'selected' : ''}`}
                onClick={() => setStrategy('dca')}
              >
                <div className="strategy-row">
                  <div className="strategy-icon dca">↓</div>
                  <div className="strategy-info">
                    <span className="strategy-name">Dollar Cost Average</span>
                    <span className="strategy-desc">Buy a fixed USDC amount of SOL on a recurring schedule.</span>
                  </div>
                  <div className={`radio ${strategy === 'dca' ? 'active' : ''}`} />
                </div>
                {strategy === 'dca' && (
                  <div className="strategy-fields">
                    <div className="sfield">
                      <label>AMOUNT (USDC)</label>
                      <input type="number" value={dcaAmount} min={1}
                        onChange={e => setDcaAmount(Number(e.target.value))}
                        onClick={e => e.stopPropagation()} />
                    </div>
                    <div className="sfield">
                      <label>SCHEDULE</label>
                      <select value={dcaSchedule}
                        onChange={e => setDcaSchedule(e.target.value)}
                        onClick={e => e.stopPropagation()}>
                        <option>Every day</option>
                        <option>Every Monday</option>
                        <option>Every Sunday</option>
                        <option>Every month</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>

              <div
                className={`strategy-item ${strategy === 'rebalance' ? 'selected' : ''}`}
                onClick={() => setStrategy('rebalance')}
              >
                <div className="strategy-row">
                  <div className="strategy-icon rebalance">⇄</div>
                  <div className="strategy-info">
                    <span className="strategy-name">Portfolio Rebalance</span>
                    <span className="strategy-desc">Keep SOL/USDC within your target band. Agent corrects hourly when drift is exceeded.</span>
                  </div>
                  <div className={`radio ${strategy === 'rebalance' ? 'active' : ''}`} />
                </div>
                {strategy === 'rebalance' && (
                  <div className="strategy-fields">
                    <div className="sfield">
                      <label>SOL TARGET %</label>
                      <input type="number" value={solTarget} min={0} max={100}
                        onChange={e => setSolTarget(Number(e.target.value))}
                        onClick={e => e.stopPropagation()} />
                    </div>
                    <div className="sfield">
                      <label>DRIFT THRESHOLD %</label>
                      <input type="number" value={driftThreshold} min={1} max={30}
                        onChange={e => setDriftThreshold(Number(e.target.value))}
                        onClick={e => e.stopPropagation()} />
                    </div>
                  </div>
                )}
              </div>

              <div
                className={`strategy-item ${strategy === 'signal' ? 'selected' : ''}`}
                onClick={() => setStrategy('signal')}
              >
                <div className="strategy-row">
                  <div className="strategy-icon signal">⚡</div>
                  <div className="strategy-info">
                    <span className="strategy-name">Buy the Dip</span>
                    <span className="strategy-desc">Buy SOL automatically when its price drops by your trigger percentage. Checked every 15 min.</span>
                  </div>
                  <div className={`radio ${strategy === 'signal' ? 'active' : ''}`} />
                </div>
                {strategy === 'signal' && (
                  <div className="strategy-fields">
                    <div className="sfield">
                      <label>PRICE DROP TRIGGER %</label>
                      <input type="number" value={signalDrop} min={1} max={50}
                        onChange={e => setSignalDrop(Number(e.target.value))}
                        onClick={e => e.stopPropagation()} />
                    </div>
                    <div className="sfield">
                      <label>BUY AMOUNT (USDC)</label>
                      <input type="number" value={signalAmount} min={1}
                        onChange={e => setSignalAmount(Number(e.target.value))}
                        onClick={e => e.stopPropagation()} />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="step-btns wide">
              <button className="btn-ghost" onClick={() => setStep(2)}>← Back</button>
              <button className="btn-primary btn-launch" onClick={launchAgent} disabled={launching}>
                {launching ? (
                  <><span className="btn-spinner" /> Launching…</>
                ) : (
                  'Launch Agent →'
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
