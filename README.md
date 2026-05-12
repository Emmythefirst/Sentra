# Sentra

**Autonomous on-chain trading agents for Solana — powered by Zerion.**

Sentra lets you deploy multiple self-executing agents that buy, rebalance, or buy-the-dip on Solana mainnet within policy guardrails you set upfront. No approvals needed after launch. Each agent runs in isolation with its own wallet.

---

## Live Demo

**App**: [sentra-ashen.vercel.app](https://sentra-ashen.vercel.app/)

---

## How it works

1. **Create** — an isolated OWS wallet is generated for your agent (no raw key exposure)
2. **Set guardrails** — spend cap per tx, daily limit, chain lock, expiry date
3. **Fund** — send SOL (for fees) + USDC (for swaps) to the agent wallet
4. **Launch** — pick a strategy; the agent runs on a cron schedule without further input
5. **Manage** — pause, resume, edit guardrails, or withdraw funds any time from the dashboard

---

## Zerion integration

| Feature | Zerion surface used |
|---|---|
| Token swap routing | `/v1/swap/quotes/` |
| Portfolio positions | `/v1/wallets/:address/positions/` |
| SOL price feed | `/v1/fungibles/11111111111111111111111111111111` |
| Wallet creation | `@open-wallet-standard/core` (`ows.createWallet`) |
| Transaction signing | `ows.signTransaction` → ed25519 64-byte sig |
| Tx broadcast | `@solana/web3.js` `sendAndConfirmRawTransaction` |

---

## Strategies

| Strategy | Schedule | Description |
|---|---|---|
| **DCA** | Daily at 9 AM UTC | Buy a fixed USDC amount of SOL on a recurring schedule |
| **Rebalance** | Every hour | Keep SOL/USDC within a target allocation band |
| **Signal** | Every 15 min | Buy SOL when price drops ≥ threshold % from reference |

---

## Policy gates (enforced on every execution)

Every transaction must pass all 4 gates in sequence before executing:

1. **Gate 1 — Spend Cap**: amount ≤ `maxSpendPerTx`
2. **Gate 2 — Daily Limit**: today's total spend + amount ≤ `dailySpendLimit`
3. **Gate 3 — Expiry**: current time < `expiresAt`
4. **Gate 4 — Wallet Readiness**: SOL balance ≥ 0.005 SOL for fees + USDC balance ≥ swap amount

---

## Setup

### Prerequisites

- Node.js 22+
- A Zerion API key — [dashboard.zerion.io](https://dashboard.zerion.io)
- A Solana RPC endpoint (optional; defaults to mainnet-beta public)

### Install

```bash
git clone https://github.com/zeriontech/sentra
cd sentra
npm install
cd client && npm install && cd ..
```

### Environment

```bash
cp .env.example .env
# Fill in ZERION_API_KEY
```

```env
ZERION_API_KEY=zk_dev_...
SOLANA_RPC=https://api.mainnet-beta.solana.com
PORT=3001
```

### Run

```bash
# Server (from root)
npm run dev

# Client (from /client)
npm run dev
```

The Vite dev server proxies all `/api` requests to `localhost:3001` automatically.

---

## Multi-agent support

You can create and manage multiple agents from a single browser session. Each agent:

- Has its own isolated Solana wallet
- Runs a different strategy independently
- Has its own guardrails and expiry
- Can be paused, resumed, or withdrawn from individually

Agents are tracked in `localStorage` (`sentra_agent_ids` array). The agent list page (`/agents`) shows live balances for all agents fetched in parallel.

---

## Dashboard features

| Feature | Description |
|---|---|
| **Live balance** | SOL + USDC refreshed every 10 seconds from chain |
| **Copyable address** | Click the wallet address in the topbar to copy |
| **Funding modal** | "View instructions →" opens a step-by-step funding guide with live balance indicators |
| **Pause / Resume** | One click stops all execution; banner shows paused state |
| **Withdraw** | SOL / USDC / ALL with optional amount, sent to any Solana address |
| **Edit guardrails** | Update spend cap, daily limit, expiry without recreating the agent |
| **Agent log** | Live execution history with Solana Explorer links for successful trades |
| **Indicative chart** | Value history built from real execution log data |
| **Manual trigger** | Test your strategy outside the cron schedule (disabled when paused) |

---

## API endpoints

### Agent

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/agent/stats` | Agent + tx counts |
| `POST` | `/api/agent/create` | Create new agent wallet |
| `GET` | `/api/agent/:id` | Get agent (no secrets returned) |
| `GET` | `/api/agent/:id/logs` | Execution log |
| `POST` | `/api/agent/:id/configure` | Set strategy + goal + policies |
| `PATCH` | `/api/agent/:id/policies` | Update policies only |
| `POST` | `/api/agent/:id/pause` | Pause agent |
| `POST` | `/api/agent/:id/resume` | Resume agent |
| `POST` | `/api/agent/:id/trigger` | Run one cycle manually |
| `POST` | `/api/agent/:id/withdraw` | Withdraw SOL / USDC / ALL |

### Portfolio

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/portfolio/balance/:address` | SOL + USDC balance + SOL price |
| `GET` | `/api/portfolio/price/:symbol` | Token price from Zerion |

---

## Architecture

```
.agent-keys/<agentId>.json   ← agent config (walletName, passphrase, solAddress)
.agent-logs/<agentId>.json   ← execution history

~/.zerion/                   ← OWS encrypted keystore (never touched directly)

server/
  routes/agent.ts            ← REST API
  routes/portfolio.ts        ← balance + price
  agents/dca.ts              ← DCA strategy
  agents/rebalance.ts        ← rebalance strategy
  agents/signal.ts           ← signal / buy-the-dip strategy
  agents/swap.ts             ← Zerion swap engine
  cron/scheduler.ts          ← cron jobs (DCA daily, rebalance hourly, signal every 15 min)

client/src/pages/
  Landing/                   ← marketing page with real agent/tx stats
  Agents/                    ← multi-agent list with live balances
  SetupFlow/                 ← 3-step agent creation (wallet → guardrails → strategy)
  Dashboard/                 ← single agent management
```

### Key signing flow

OWS `signTransaction` returns a raw 64-byte ed25519 signature — not a pre-assembled transaction. The signing flow is:

```
1. Deserialize original VersionedTransaction from base64 (Zerion swap API response)
2. Pass raw tx hex to ows.signSolanaTransaction → 64-byte sig
3. tx.addSignature(pubkey, sigBytes)
4. Re-serialize → sendAndConfirmRawTransaction
```

### Railway deployment note

`~/.zerion/` is ephemeral on Railway — it is wiped on redeploy. Before deploying, export wallet mnemonics and store them securely. On redeploy, reimport via the CLI's `wallet import` command.

---

## Security model

- **No raw key storage** — agent JSON stores only `walletName` + `passphrase`; OWS holds actual key material encrypted at `~/.zerion/`
- **Policy-gated execution** — 4 gates enforced in code before every swap; agent cannot exceed user-defined limits
- **Pause / withdraw** — one-click pause stops all execution; withdraw sends full balance back to any address on demand
- **Isolated wallets** — each agent gets its own fresh wallet, independent of any other agent or user wallet
- **Wallet creation on demand** — wallets are only created when the user explicitly clicks "Generate Wallet", not on page load

---

## Built with

- [Zerion API](https://developers.zerion.io) — swap routing, portfolio data, price feeds
- [Open Wallet Standard](https://github.com/wallet-standard/wallet-standard) — non-custodial key management
- [Solana web3.js](https://github.com/solana-labs/solana-web3.js) — transaction construction + broadcast
- [React](https://react.dev) + [Recharts](https://recharts.org) — frontend
- [Express](https://expressjs.com) — backend API
- [node-cron](https://github.com/node-cron/node-cron) — strategy scheduler
