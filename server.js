// server.js
// Single-file Express API for Limo Management Systems

// ========== Core ==========
const express = require('express');
const crypto  = require('crypto');

// Create app and JSON parsing (KEEP ONLY ONE require/express + app.use)
const app = express();
app.use(express.json());

// ========== Basic CORS (no extra deps) ==========
const ALLOWED_ORIGINS = [
  'https://limomanagementsys.com.au',
  'https://app.limomanagementsys.com.au'
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  // Include the exact header name users will send:
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, LMS_API_KEY, X-Debug-ID');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ========== Env & Startup Logs ==========
const PORT = process.env.PORT || 10000; // Render usually injects a port
const SERVER_KEY_RAW = (process.env.LMS_API_KEY || '').trim();
const GOOGLE_MAPS_KEY = (process.env.GOOGLE_MAPS_KEY || '').trim();

function fp(s) {
  return crypto.createHash('sha256').update((s || '').trim()).digest('hex').slice(0, 10);
}

console.log('[startup] LMS_API_KEY present:', Boolean(SERVER_KEY_RAW), 'len:', SERVER_KEY_RAW.length);
console.log('[startup] GOOGLE_MAPS_KEY present:', Boolean(GOOGLE_MAPS_KEY));

// ========== Public routes (no auth) ==========
app.get('/api/ping', (req, res) => {
  res.json({
    pong: true,
    at: new Date().toISOString(),
    mapsConfigured: Boolean(GOOGLE_MAPS_KEY)
  });
});

// Helpful diag so you can verify header vs server env quickly
app.get('/api/diag/auth', (req, res) => {
  const clientKey =
    req.get('LMS_API_KEY') ??
    req.get('lms_api_key') ??
    req.get('lms-api-key') ?? // tolerate variants silently
    '';

  const ok = Boolean(SERVER_KEY_RAW) && clientKey && (SERVER_KEY_RAW === clientKey.trim());

  res.json({
    ok,
    match: ok,
    server: {
      hasKey: Boolean(SERVER_KEY_RAW),
      fp: fp(SERVER_KEY_RAW)
    },
    client: {
      present: Boolean(clientKey),
      fp: fp(clientKey)
    }
  });
});

// ========== Auth middleware (protect everything below) ==========
const AUTH_WHITELIST = new Set(['/api/ping', '/api/diag/auth']);
app.use((req, res, next) => {
  if (AUTH_WHITELIST.has(req.path)) return next();

  const clientKey =
    req.get('LMS_API_KEY') ??
    req.get('lms_api_key') ??
    req.get('lms-api-key') ?? '';

  const valid = Boolean(SERVER_KEY_RAW) && clientKey && (SERVER_KEY_RAW === clientKey.trim());
  if (!valid) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
});

// ========== Helpers ==========
function calcTotal({ distanceKm, durationMin, pax, luggage }) {
  // Pricing model (matches your earlier examples):
  const base = 65;
  const perKm = 2.2;
  const perPax = 5;      // flat add-on (NOT multiplied per pax)
  const perBag = 2;      // multiplied by luggage count

  const total =
    base +
    perKm * distanceKm +
    perPax +
    perBag * (Number(luggage) || 0);

  return {
    total: Math.round(total * 100) / 100,
    breakdown: { base, perKm, distanceKm, distanceSource: null, perPax, perBag, durationMin }
  };
}

async function getDistanceViaGoogle(pickup, dropoff) {
  const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
  url.searchParams.set('origins', pickup);
  url.searchParams.set('destinations', dropoff);
  url.searchParams.set('departure_time', 'now');
  url.searchParams.set('key', GOOGLE_MAPS_KEY);

  const r = await fetch(url.toString(), { method: 'GET' });
  if (!r.ok) throw new Error(`Maps HTTP ${r.status}`);
  const data = await r.json();

  const row = data?.rows?.[0];
  const el = row?.elements?.[0];
  if (!el || el.status !== 'OK') {
    throw new Error(`Maps element status: ${el?.status || 'Unknown'}`);
  }
  const meters = el.distance?.value ?? 0;
  const seconds = el.duration_in_traffic?.value ?? el.duration?.value ?? 0;
  const km = meters / 1000;
  const min = seconds ? Math.round(seconds / 60) : null;

  return { distanceKm: km, durationMin: min, source: 'google' };
}

function roughDistance(pickup, dropoff) {
  // “Good enough” fallback if Google fails/missing.
  // Keep your common case consistent with earlier results:
  const p = (pickup || '').toLowerCase();
  const d = (dropoff || '').toLowerCase();
  if (p.includes('brisbane airport') && d.includes('south bank')) {
    return { distanceKm: 16, durationMin: null, source: 'rough' };
  }
  // Generic fallback
  return { distanceKm: 12, durationMin: null, source: 'rough' };
}

// ========== Quote route ==========
app.post('/api/quote', async (req, res) => {
  try {
    const { pickup, dropoff, when, pax, luggage } = req.body || {};
    if (!pickup || !dropoff || !when) {
      return res.status(400).json({ ok: false, error: 'Missing pickup/dropoff/when' });
    }

    let distanceKm, durationMin, distanceSource;

    if (GOOGLE_MAPS_KEY) {
      try {
        const g = await getDistanceViaGoogle(pickup, dropoff);
        distanceKm = g.distanceKm;
        durationMin = g.durationMin;
        distanceSource = g.source;
      } catch (err) {
        console.warn('[maps-fallback]', err.message);
        const r = roughDistance(pickup, dropoff);
        distanceKm = r.distanceKm;
        durationMin = r.durationMin;
        distanceSource = r.source;
      }
    } else {
      const r = roughDistance(pickup, dropoff);
      distanceKm = r.distanceKm;
      durationMin = r.durationMin;
      distanceSource = r.source;
    }

    const pricing = calcTotal({ distanceKm, durationMin, pax, luggage });
    pricing.breakdown.distanceKm = Math.round(distanceKm * 1000) / 1000; // nice rounding
    pricing.breakdown.distanceSource = distanceSource;

    res.json({
      ok: true,
      quote: {
        currency: 'AUD',
        total: pricing.total,
        breakdown: pricing.breakdown,
        pickup,
        dropoff,
        when,
        pax: Number(pax) || 0,
        luggage: Number(luggage) || 0
      }
    });
  } catch (err) {
    console.error('[quote-error]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ========== Global error guards ==========
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

// ========== Start ==========
app.listen(PORT, () => {
  console.log('[startup] API listening on', PORT);
});

