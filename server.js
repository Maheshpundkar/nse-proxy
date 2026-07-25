// ─────────────────────────────────────────────────────────────
// OptionFlow NSE Proxy — the "middleman" between your website and NSE.
// You do not need to understand this file. Just upload it as-is.
// ─────────────────────────────────────────────────────────────
const express = require('express');
const axios = require('axios');
const app = express();

// Let your website (and any website) call this proxy freely.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nseindia.com/option-chain'
};

let cookieJar = '';
let cookieFetchedAt = 0;

// NSE only allows requests that first "walk through the front door"
// (visit the homepage) and carry the cookie it hands out there.
async function refreshCookies() {
  const res = await axios.get('https://www.nseindia.com/option-chain', {
    headers: NSE_HEADERS,
    timeout: 8000
  });
  cookieJar = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  cookieFetchedAt = Date.now();
}

app.get('/option-chain/:symbol', async (req, res) => {
  try {
    // Refresh the cookie every ~4 minutes, NSE expires it quickly.
    if (!cookieJar || Date.now() - cookieFetchedAt > 4 * 60 * 1000) {
      await refreshCookies();
    }
    const symbol = req.params.symbol.toUpperCase();
    const isIndex = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'].includes(symbol);
    const url = isIndex
      ? `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol}`
      : `https://www.nseindia.com/api/option-chain-equities?symbol=${symbol}`;

    const r = await axios.get(url, {
      headers: { ...NSE_HEADERS, Cookie: cookieJar },
      timeout: 8000
    });
    res.json(r.data);
  } catch (e) {
    cookieJar = ''; // force a fresh cookie next try
    res.status(502).json({ error: 'NSE fetch failed, try again in a few seconds', detail: e.message });
  }
});

// Simple homepage so you can confirm it's alive by just opening the link.
app.get('/', (req, res) => {
  res.send('✅ OptionFlow NSE Proxy is running. Try /option-chain/NIFTY');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Proxy running on port ' + PORT));
