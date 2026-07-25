// ─────────────────────────────────────────────────────────────
// OptionFlow Angel One Proxy — logs into your Angel One account,
// downloads the day's instrument list, and serves live NIFTY /
// BANKNIFTY option chain data in the same shape your website expects.
//
// You do not need to understand this file. It reads your credentials
// from Render's Environment Variables (set those in Render's dashboard,
// never in this file, never sent to anyone).
//
// Call it like:
//   https://YOUR-RENDER-URL.onrender.com/option-chain/NIFTY
//   https://YOUR-RENDER-URL.onrender.com/option-chain/BANKNIFTY
// ─────────────────────────────────────────────────────────────
const express = require('express');
const axios = require('axios');
const { authenticator } = require('otplib');

const app = express();
app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); next(); });

const BASE = 'https://apiconnect.angelone.in';
const SCRIP_MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

const SPOT_TOKENS = {
  NIFTY: { token: '99926000', exch: 'NSE', step: 50 },
  BANKNIFTY: { token: '99926009', exch: 'NSE', step: 100 }
};

function staticHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00',
    'X-PrivateKey': process.env.ANGEL_API_KEY
  };
}

// ── Session (login) — cached for 6 hours so we don't log in on every request
let session = { jwtToken: null, expiresAt: 0 };
async function login() {
  if (session.jwtToken && Date.now() < session.expiresAt) return session.jwtToken;
  const totp = authenticator.generate(process.env.ANGEL_TOTP_SECRET);
  const res = await axios.post(`${BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
    clientcode: process.env.ANGEL_CLIENT_CODE,
    password: process.env.ANGEL_MPIN,
    totp
  }, { headers: staticHeaders() });
  if (!res.data?.data?.jwtToken) throw new Error('Login failed: ' + JSON.stringify(res.data));
  session.jwtToken = res.data.data.jwtToken;
  session.expiresAt = Date.now() + 6 * 60 * 60 * 1000;
  return session.jwtToken;
}
function authHeaders(jwt) { return { ...staticHeaders(), Authorization: `Bearer ${jwt}` }; }

// ── Instrument list — Angel One publishes this once a day, so we cache it
let scripCache = { data: null, fetchedAt: 0 };
async function getScripMaster() {
  if (scripCache.data && Date.now() - scripCache.fetchedAt < 20 * 60 * 60 * 1000) return scripCache.data;
  const res = await axios.get(SCRIP_MASTER_URL, { timeout: 30000 });
  scripCache = { data: res.data, fetchedAt: Date.now() };
  return res.data;
}

// ── Per-strike OI baseline, used to compute "change in OI" since this
// server started watching that strike today (resets daily / on restart).
const oiBaseline = new Map();

app.get('/option-chain/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const spotInfo = SPOT_TOKENS[symbol];
    if (!spotInfo) return res.status(400).json({ error: 'Unsupported symbol. Use NIFTY or BANKNIFTY.' });

    const jwt = await login();
    const master = await getScripMaster();

    const contracts = master.filter(x => x.name === symbol && x.instrumenttype === 'OPTIDX' && x.exch_seg === 'NFO');
    const expiries = [...new Set(contracts.map(c => c.expiry))].sort((a, b) => new Date(a) - new Date(b));
    const chosenExpiry = req.query.expiry || expiries[0];
    const chain = contracts.filter(c => c.expiry === chosenExpiry);

    // Spot LTP
    const spotRes = await axios.post(`${BASE}/rest/secure/angelbroking/market/v1/quote`,
      { mode: 'LTP', exchangeTokens: { [spotInfo.exch]: [spotInfo.token] } },
      { headers: authHeaders(jwt) });
    const spotLtp = spotRes.data?.data?.fetched?.[0]?.ltp || 0;

    // Keep the grid to a sane window around spot (±40 strikes) instead of the whole chain
    const atm = Math.round(spotLtp / spotInfo.step) * spotInfo.step;
    const nearby = chain.filter(c => Math.abs((+c.strike / 100) - atm) <= spotInfo.step * 40);

    // Angel's quote API accepts up to 50 tokens per call — batch accordingly
    const tokens = nearby.map(c => c.token);
    const batches = [];
    for (let i = 0; i < tokens.length; i += 50) batches.push(tokens.slice(i, i + 50));

    const quoteMap = {};
    for (const batch of batches) {
      const r = await axios.post(`${BASE}/rest/secure/angelbroking/market/v1/quote`,
        { mode: 'FULL', exchangeTokens: { NFO: batch } },
        { headers: authHeaders(jwt) });
      (r.data?.data?.fetched || []).forEach(q => { quoteMap[q.symbolToken] = q; });
    }

    const today = new Date().toISOString().slice(0, 10);
    const byStrike = {};
    nearby.forEach(c => {
      const strike = +c.strike / 100;
      const side = c.symbol.endsWith('CE') ? 'CE' : 'PE';
      const q = quoteMap[c.token];
      if (!q) return;
      const oi = q.opnInterest || 0;
      const base = oiBaseline.get(c.token);
      if (!base || base.date !== today) oiBaseline.set(c.token, { date: today, oi });
      const chgOi = oi - oiBaseline.get(c.token).oi;

      if (!byStrike[strike]) byStrike[strike] = { strikePrice: strike, expiryDate: chosenExpiry };
      byStrike[strike][side] = {
        strikePrice: strike,
        expiryDate: chosenExpiry,
        openInterest: oi,
        changeinOpenInterest: chgOi,
        impliedVolatility: 0,
        lastPrice: q.ltp || 0,
        change: q.netChange || 0,
        pChange: q.percentChange || 0,
        totalTradedVolume: q.tradeVolume || 0,
        bidQty: q.totBuyQuan || 0,
        askQty: q.totSellQuan || 0
      };
    });

    res.json({
      records: {
        expiryDates: expiries,
        underlyingValue: spotLtp,
        data: Object.values(byStrike).sort((a, b) => a.strikePrice - b.strikePrice)
      }
    });
  } catch (err) {
    res.status(502).json({ error: 'Angel One fetch failed, try again in a few seconds', detail: err.response?.data || err.message });
  }
});

app.get('/', (req, res) => res.send('✅ OptionFlow Angel One Proxy is running. Try /option-chain/NIFTY'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Angel One proxy running on port ' + PORT));
