# Balance & Price Fetch Debugging Guide

## What Was Wrong

Your app had **three critical issues** preventing balance and price display:

### 1. **Silent Error Handling** ❌
The frontend had empty `catch {}` blocks that silently swallowed all errors:

```javascript
// BEFORE (bad)
async function fetchBalance(publicKey: string) {
  try {
    const { data } = await axios.get(`${API}/portfolio/balance/${publicKey}`);
    if (data.success) setBalance(data);
  } catch {}  // ← Error silently ignored!
}
```

This meant if the API call failed, you'd see "Fetching balance..." forever without knowing why.

### 2. **No Error State** ❌
If the balance fetch failed, there was no way to display the error to the user. The UI just showed "—" or "Fetching balance...".

### 3. **useEffect Dependency Issue** ❌
The polling interval was set up in one effect, but `agent` was in a separate render. This could cause timing issues where the interval tries to use an old `agent` value.

## What Was Fixed

### Frontend Fixes

**Added error logging to all API calls:**
```javascript
async function fetchBalance(publicKey: string) {
  try {
    const { data } = await axios.get(`${API}/portfolio/balance/${publicKey}`);
    
    if (data.success) {
      setBalance(data);
      setBalanceError(null);
      console.log('[Dashboard] Balance fetched:', { sol: data.sol, usdc: data.usdc, price: data.price });
    } else {
      const errMsg = data.error || 'Unknown error';
      setBalanceError(errMsg);  // ← Now shows error to user
      console.warn('[Dashboard] API returned error:', errMsg);
    }
  } catch (err: any) {
    const errMsg = err.response?.data?.error || err.message || 'Network error';
    setBalanceError(errMsg);  // ← Stores error message
    console.error('[Dashboard] Failed to fetch balance:', errMsg);
  }
}
```

**Fixed useEffect to properly track `agent` updates:**
```javascript
// BEFORE: Single effect that doesn't re-run when agent changes
useEffect(() => {
  loadAgent();
  const interval = setInterval(() => {
    if (agent?.publicKey) fetchBalance(agent.publicKey);  // ← might be null!
  }, 10000);
}, [agentId]);

// AFTER: Separate effects for initial load and polling
useEffect(() => {
  loadAgent();  // Load agent once when component mounts
}, [agentId]);

useEffect(() => {
  if (!agent?.publicKey) return;  // Wait until agent is loaded
  
  fetchBalance(agent.publicKey);  // Fetch immediately
  const interval = setInterval(() => {
    fetchBalance(agent.publicKey);  // Poll every 10s
  }, 10000);
  
  return () => clearInterval(interval);
}, [agent?.publicKey]);  // Re-run when agent changes
```

**Added error display in UI:**
```javascript
// Show error message when balance fetch fails
{balance
  ? `${balance.sol.toFixed(4)} SOL · ${balance.usdc?.toFixed(2)} USDC`
  : balanceError 
    ? `Error: ${balanceError}`  // ← User now sees error!
    : 'Fetching balance...'}
```

### Backend Fixes

**Added detailed logging to balance endpoint:**
```javascript
router.get('/balance/:publicKey', async (req: Request, res: Response) => {
  try {
    console.log(`[Portfolio] Fetching balance for: ${publicKey}`);
    console.log(`[Portfolio] Getting SOL balance...`);
    // ... fetch balances ...
    console.log(`[Portfolio] Fetching SOL price from Zerion API...`);
    console.log(`[Portfolio] Auth header: ${authHeader.slice(0, 20)}...`);
    // ... make API call ...
    console.log(`[Portfolio] ✅ Balance fetch complete`);
    res.json({ success: true, sol, usdc, usd: totalUsd, price, change24h });
  } catch (err: any) {
    console.error(`[Portfolio] ❌ Error: ${err.message}`);
    if (err.response?.status === 401) {
      console.error('[Portfolio] Auth error - check ZERION_API_KEY');
    }
    if (err.response?.status === 429) {
      console.error('[Portfolio] Rate limited by Zerion API');
    }
    res.status(500).json({ success: false, error: err.message });
  }
});
```

## How to Diagnose Issues Now

### Step 1: Check Server Logs
Start the server and watch for these logs when you load the dashboard:

```bash
npm run server
```

Look for output like:
```
[Portfolio] Fetching balance for: F3u4xyz...
[Portfolio] Getting SOL balance...
[Portfolio] SOL balance: 10.5
[Portfolio] Getting USDC balance...
[Portfolio] USDC balance: 500
[Portfolio] Fetching SOL price from Zerion API...
[Portfolio] Auth header: Basic zk_...
[Portfolio] SOL price: $185.50, 24h change: 5.2%
[Portfolio] Total USD value: $2433.25
[Portfolio] ✅ Balance fetch complete
```

Or if there's an error:
```
[Portfolio] Fetching balance for: F3u4xyz...
[Portfolio] Getting SOL balance...
[Portfolio] ❌ Balance fetch error: 401 Unauthorized
[Portfolio] Auth error - check ZERION_API_KEY
```

### Step 2: Check Browser Console
Open DevTools (F12) → Console tab. Look for logs like:

```javascript
[Dashboard] Balance fetched successfully: {sol: 10.5, usdc: 500, price: 185.50}
```

Or error logs:
```javascript
[Dashboard] Failed to fetch balance: 401 Unauthorized
```

### Step 3: Check the UI
- If balance shows: ✅ Everything working
- If balance shows error: ❌ Check server logs for the specific error
- If balance shows "Fetching balance...": ⏳ Request is stuck, check network tab

### Step 4: Test the API Endpoint Directly

```bash
# From your terminal (replace PUBLIC_KEY with actual wallet address)
curl http://localhost:3001/api/portfolio/balance/F3u4xyz...

# Should return either:
# {"success":true,"sol":10.5,"usdc":500,"usd":2433.25,"price":185.50,"change24h":5.2}
# or
# {"success":false,"error":"401 Unauthorized"}
```

## Common Error Messages and Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `401 Unauthorized` | Bad ZERION_API_KEY | Verify API key in `.env` and restart server |
| `429 Too Many Requests` | Rate limited | Increase interval or use cache |
| `Network error` | Can't reach Zerion API | Check internet connection |
| `No USDC account found` | Wallet has no USDC | This is OK, balance shows 0 |
| `Invalid public key` | Bad wallet address | Check the wallet address is valid |

## Verification Checklist

After applying these fixes:

- [ ] Check server logs when loading dashboard
- [ ] Browser console shows `[Dashboard] Balance fetched` (not errors)
- [ ] Portfolio value displays a number (not "—" or error)
- [ ] SOL price shows in sidebar
- [ ] Balance shows sol/usdc amounts
- [ ] No errors appear in browser or server console

## If Still Not Working

1. **Restart the server** (sometimes environment changes need a reload):
   ```bash
   npm run server
   ```

2. **Check ZERION_API_KEY is correct:**
   ```bash
   cat .env | grep ZERION_API_KEY
   ```

3. **Test Zerion API directly:**
   ```bash
   curl -H "Authorization: Basic $(echo -n 'YOUR_KEY:' | base64)" \
     https://api.zerion.io/v1/fungibles/11111111111111111111111111111111
   ```

4. **Clear browser cache** (sometimes old JS cached):
   - Open DevTools (F12)
   - Right-click refresh button → "Empty cache and hard reload"

5. **Check if SOLANA_RPC is set:**
   ```bash
   cat .env | grep SOLANA_RPC
   # If not set, it uses the default: https://api.mainnet-beta.solana.com
   ```
