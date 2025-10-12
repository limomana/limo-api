// server.js
// Simple Express API for LMS quotes, with key auth and optional Google Maps distance.

// Local .env support (harmless on Render)
try { require('dotenv').config(); } catch (_) {}

const express = require('express');
const app = express();

// Basic app setup
app.set('trust proxy', true);
app.use(express.json());

// --- CORS (allow your WP site) ---
const ALLOW_ORIGIN = 'https://limomanagementsys.com.au';
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, LMS_API_KEY, LMS-Api-Key, X-Api-Key'
  );
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- Keys ---
const SERVER_KEY = (process.env.LMS_API_KEY || '').trim();
const MAPS_KEY   = (process.env.GOOGLE_MAPS_KEY || '').trim();

// Startup logs (safe, no secrets)
console.log('LMS_API_KEY present:', Boolean(SERVER_KEY), 'len:', SERVER_KEY.length);
console.log('GOOGLE_MAPS_KEY present:', Boolean(MAPS_KEY), 'len:', MAPS_KEY.length);

// Utility: read client key from multiple header spellings (case-insensitive)
function getClientKey(req) {
  return (
    (req.get('LMS_API_KEY') || '') ||
    (req.get('LMS-Api-Key') || '') ||
    (req.get('X-Api-Key') || '') ||
    (req.query.key || '')
  ).trim();
}

// --- Auth middleware ---
// Open: /api/ping and /api/diag/auth
const OPEN_PATHS = new Set(['/api/ping', '/api/diag/auth']);

app.use((req, res, next) => {
  if (OPEN_PATHS.has(req.path)) return next();

  if (!SERVER_KEY) {
    return res.status(500).json({ ok: false, error: 'Server key not configured' });
  }

  const clientKey = getClientKey(req);
  if (clientKey !== SERVER_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  return next();
});

// --- Health ---
app.get('/api/ping', (req, res) => {
  res.json({
    pong: true,
    at: new Date().toISOString(),
    mapsConfigured: Boolean(MAPS_KEY),
  });
});

// --- Diag auth (no auth required so you can test headers easily) ---
app.get('/api/diag/auth', (req, res) => {
  const clientKey = getClientKey(req);
  const match = Boolean(SERVER_KEY) && clientKey === SERVER_KEY;

  const fp = (v) => {
    const t = (v || '').trim();
    return { len: t.length, head: t.slice(0, 4), tail: t.slice(-4) };
  };

  res.json({
    ok: true,
    serverKeyPresent: Boolean(SERVER_KEY),
    clientKeyPresent: Boolean(clientKey),
    match,
    serverFp: fp(SERVER_KEY),
    clientFp: fp(clientKey),
  });
});

// --- Quote helper: price calc ---
function calculatePrice({ distanceKm, pax, luggage }) {
  const breakdown = {
    base: 65,
    perKm: 2.2,
    perPax: 5,
    perBag: 2,
    distanceKm: distanceKm,
    distanceSource: null,    // filled by caller
    durationMin: null,       // filled by caller if we have it
  };

  const total =
    breakdown.base +
    breakdown.perKm * breakdown.distanceKm +
    breakdown.perPax * (Number(pax) || 0) +
    breakdown.perBag * (Number(luggage) || 0);

  // Round to 2 decimals
  const rounded = Math.round(total * 100) / 100;
  return { total: rounded, breakdown };
}

// --- Quote helper: Google Distance Matrix ---
async function getGoogleDistance(pickup, dropoff) {
  if (!MAPS_KEY) return null;

  const params = new URLSearchParams({
    origins: pickup,
    destinations: dropoff,
    units: 'metric',
    key: MAPS_KEY,
  });

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`;

  try {
    const resp = await fetch(url, { method: 'GET', redirect: 'follow' });
    if (!resp.ok) {
      console.error('Google DM API HTTP error:', resp.status);
      return null;
    }
    const data = await resp.json();

    if (
      data.status !== 'OK' ||
      !data.rows ||
      !data.rows[0] ||
      !data.rows[0].elements ||
      !data.rows[0].elements[0] ||
      data.rows[0].elements[0].status !== 'OK'
    ) {
      console.warn('Google DM API non-OK payload:', data.status, JSON.stringify(data));
      return null;
    }

    const el = data.rows[0].elements[0];
    const distanceMeters = el.distance?.value ?? null;
    const durationSeconds = el.duration?.value ?? null;
    if (distanceMeters == null) return null;

    return {
      distanceKm: Math.round((distanceMeters / 1000) * 1000) / 1000, // km to 3dp
      durationMin: durationSeconds != null ? Math.round(durationSeconds / 60) : null,
      source: 'google',
    };
  } catch (err) {
    console.error('Google DM fetch error:', err);
    return null;
  }
}

// --- Quote helper: rough fallback distances (tiny example) ---
function roughDistanceKm(pickup, dropoff) {
  const key = `${pickup} -> ${dropoff}`.toLowerCase().trim();
  const table = new Map([
    ['brisbane airport -> south bank', 16], // your known path
  ]);
  return table.get(key) ?? 12; // default to 12km if unknown
}

// --- Quote endpoint ---
app.post('/api/quote', async (req, res) => {
  try {
    const { pickup, dropoff, when, pax, luggage } = req.body || {};

    if (!pickup || !dropoff) {
      return res.status(400).json({ ok: false, error: 'pickup and dropoff are required' });
    }

    // Try Google first (if key present), else fallback
    let distanceKm, durationMin, distanceSource;

    const googleResult = await getGoogleDistance(pickup, dropoff);
    if (googleResult) {
      distanceKm = googleResult.distanceKm;
      durationMin = googleResult.durationMin;
      distanceSource = googleResult.source;
    } else {
      distanceKm = roughDistanceKm(pickup, dropoff);
      distanceSource = 'rough';
      durationMin = null;
    }

    const pricing = calculatePrice({ distanceKm, pax, luggage });
    pricing.breakdown.distanceKm = distanceKm;
    pricing.breakdown.distanceSource = distanceSource;
    pricing.breakdown.durationMin = durationMin;

    return res.json({
      ok: true,
      quote: {
        currency: 'AUD',
        total: pricing.total,
        breakdown: pricing.breakdown,
        pickup,
        dropoff,
        when,
        pax,
        luggage,
      },
    });
  } catch (err) {
    console.error('Quote error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('API listening on', PORT);
});
