// --- Minimal, clean, single-file API ---
// Auth: expects header  LMS_API_KEY: <exact value>
// Env:  LMS_API_KEY, GOOGLE_MAPS_KEY (optional for distance)
// Node: 20.x (pinned via package.json)

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

const SERVICE_API_KEY = (process.env.LMS_API_KEY || '').trim();
const GOOGLE_MAPS_KEY = (process.env.GOOGLE_MAPS_KEY || '').trim();

// Basic CORS (web + app domains + local)
const ALLOW_ORIGINS = [
  'https://limomanagementsys.com.au',
  'https://app.limomanagementsys.com.au',
  'http://localhost:3000',
  'http://localhost:5173'
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOW_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  }
}));
app.use(express.json({ limit: '512kb' }));

// Startup diagnostics
console.log('--- LMS API starting ---');
console.log('Node version:', process.version);
console.log('LMS_API_KEY present:', Boolean(SERVICE_API_KEY), 'len:', SERVICE_API_KEY.length);
console.log('GOOGLE_MAPS_KEY present:', Boolean(GOOGLE_MAPS_KEY), 'len:', GOOGLE_MAPS_KEY.length);
console.log('PORT:', PORT);

// Health
app.get('/api/ping', (req, res) => {
  res.json({
    pong: true,
    at: new Date().toISOString(),
    mapsConfigured: Boolean(GOOGLE_MAPS_KEY)
  });
});

// Simple auth middleware (header only)
function requireApiKey(req, res, next) {
  // Accept exactly the LMS_API_KEY header (case-insensitive)
  const provided =
    (req.get('LMS_API_KEY') || req.get('lms_api_key') || req.get('Lms_Api_Key') || '').trim();

  if (!SERVICE_API_KEY) {
    console.warn('WARNING: No LMS_API_KEY set on server. Allowing requests (DEV MODE).');
    return next();
  }

  if (provided && provided === SERVICE_API_KEY) return next();

  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

// Distance helper: try Google; fallback to rough estimate
async function getDistanceKm(pickup, dropoff) {
  try {
    if (!GOOGLE_MAPS_KEY) throw new Error('no-maps-key');

    // Node 20 has global fetch
    const url = 'https://maps.googleapis.com/maps/api/distancematrix/json' +
      `?origins=${encodeURIComponent(pickup)}` +
      `&destinations=${encodeURIComponent(dropoff)}` +
      `&units=metric&key=${encodeURIComponent(GOOGLE_MAPS_KEY)}`;

    const r = await fetch(url, { method: 'GET' });
    const j = await r.json();

    const row = j?.rows?.[0]?.elements?.[0];
    const meters = row?.distance?.value;
    const durationSec = row?.duration?.value;

    if (meters && meters > 0) {
      return {
        km: Math.round((meters / 1000) * 1000) / 1000,
        durationMin: durationSec ? Math.round(durationSec / 60) : null,
        source: 'google'
      };
    }

    throw new Error('no-distance');
  } catch {
    // Fallback so the API still works
    return { km: 16, durationMin: null, source: 'rough' };
  }
}

// Quote endpoint
app.post('/api/quote', requireApiKey, async (req, res) => {
  try {
    const { pickup, dropoff, when, pax, luggage } = req.body || {};

    if (!pickup || !dropoff) {
      return res.status(400).json({ ok: false, error: 'pickup and dropoff are required' });
    }

    const paxNum = Number.isFinite(+pax) ? +pax : 1;
    const bagNum = Number.isFinite(+luggage) ? +luggage : 0;

    const dist = await getDistanceKm(String(pickup), String(dropoff));

    // Pricing model (matches your earlier results):
    const base = 65;
    const perKm = 2.2;
    const perPax = 5;      // surcharge if pax > 1 (flat)
    const perBag = 2;      // surcharge if luggage > 0 (flat)

    const km = dist.km;
    const paxSurcharge = paxNum > 1 ? perPax : 0;
    const bagSurcharge = bagNum > 0 ? perBag : 0;

    const total = +(base + perKm * km + paxSurcharge + bagSurcharge).toFixed(2);

    return res.json({
      ok: true,
      quote: {
        currency: 'AUD',
        total,
        breakdown: {
          base,
          perKm,
          distanceKm: km,
          distanceSource: dist.source,
          perPax,
          perBag,
          durationMin: dist.durationMin
        },
        pickup,
        dropoff,
        when: when || null,
        pax: paxNum,
        luggage: bagNum
      }
    });
  } catch (e) {
    console.error('Quote error:', e);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// 404
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

// Start
app.listen(PORT, () => {
  console.log(`LMS API listening on ${PORT}`);
});


// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('API listening on', PORT);
});
