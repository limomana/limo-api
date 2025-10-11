// server.js
'use strict';

const express = require('express');

const app = express();
app.use(express.json());
const API_KEY  = (process.env.LMS_API_KEY || '').trim();
const MAPS_KEY = (process.env.GOOGLE_MAPS_KEY || '').trim();

console.log(
  'LMS_API_KEY present:', Boolean(API_KEY),
  'len:', API_KEY.length,
  'GOOGLE_MAPS_KEY present:', Boolean(MAPS_KEY),
  'len:', MAPS_KEY.length
);

// ----- config / env -----
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://limomanagementsys.com.au';
const EXPECTED_KEY = (process.env.LMS_API_KEY || '').trim();
const GOOGLE_MAPS_KEY = (process.env.GOOGLE_MAPS_KEY || '').trim();

// A little startup visibility (does NOT print secrets)
console.log('LMS_API_KEY present:', !!EXPECTED_KEY, 'len:', EXPECTED_KEY.length);
console.log('GOOGLE_MAPS_KEY present:', !!GOOGLE_MAPS_KEY);

// ----- very light CORS (allow your site) -----
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, LMS-Api-Key, X-Api-Key, X-Debug-ID');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Optional: log a per-request debug id if client sends one
app.use((req, _res, next) => {
  const did = req.get('X-Debug-ID');
  if (did) console.log(`[${new Date().toISOString()}] req ${req.method} ${req.originalUrl} debug=${did}`);
  next();
});

// ----- health -----
app.get('/api/ping', (req, res) => {
  res.json({
    pong: true,
    at: new Date().toISOString(),
    mapsConfigured: !!GOOGLE_MAPS_API_KEY
  });
});

// ----- API key guard (protect everything under /api EXCEPT /api/ping) -----
app.use('/api', (req, res, next) => {
  if (req.path === '/ping') return next(); // leave ping open
  if (!EXPECTED_KEY) {
    return res.status(500).json({ ok: false, error: 'Server misconfigured (LMS_API_KEY missing)' });
  }
  const provided = (req.get('LMS-Api-Key') || req.get('X-Api-Key') || '').trim();
  if (provided !== EXPECTED_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
});

// ----- helpers -----
async function getDistanceKmAndDuration(pickup, dropoff) {
  // If a Google key is available, use Distance Matrix with textual origins/destinations.
  if (GOOGLE_MAPS_KEY) {
    try {
      const params = new URLSearchParams({
        origins: pickup,
        destinations: dropoff,
        units: 'metric',
        key: GOOGLE_MAPS_API_KEY
      });
      const url = 'https://maps.googleapis.com/maps/api/distancematrix/json?' + params.toString();
      const resp = await fetch(url);
      const data = await resp.json();

      if (data.status === 'OK' &&
          data.rows &&
          data.rows[0] &&
          data.rows[0].elements &&
          data.rows[0].elements[0] &&
          data.rows[0].elements[0].status === 'OK') {
        const el = data.rows[0].elements[0];
        const distanceKm = (el.distance.value || 0) / 1000; // meters -> km
        const durationMin = Math.round((el.duration.value || 0) / 60); // secs -> mins
        return { distanceKm, durationMin, distanceSource: 'google' };
      }
      console.warn('DistanceMatrix returned non-OK:', JSON.stringify(data));
    } catch (e) {
      console.warn('DistanceMatrix error:', e);
    }
  }

  // Fallback rough guess if Google failed/not configured
  return { distanceKm: 16, durationMin: null, distanceSource: 'rough' };
}

function priceFrom(distanceKm, pax, luggage) {
  const base = 65;
  const perKm = 2.2;
  const perPax = 5;   // charged for extra passengers after the first
  const perBag = 2;

  const extraPax = Math.max((Number(pax) || 0) - 1, 0);
  const bags = Number(luggage) || 0;

  const total = base + (perKm * distanceKm) + (perPax * extraPax) + (perBag * bags);
  return {
    total: Number(total.toFixed(2)),
    breakdown: {
      base, perKm, distanceKm: Number(distanceKm.toFixed(3)),
      distanceSource: null, // fill by caller
      perPax, perBag,
      durationMin: null     // fill by caller
    }
  };
}

// ----- quote endpoint -----
// expects JSON: { pickup, dropoff, when, pax, luggage }
app.post('/api/quote', async (req, res) => {
  try {
    const { pickup, dropoff, when, pax, luggage } = req.body || {};
    if (!pickup || !dropoff) {
      return res.status(400).json({ ok: false, error: 'pickup and dropoff are required' });
    }

    const dist = await getDistanceKmAndDuration(pickup, dropoff);
    const priced = priceFrom(dist.distanceKm, pax, luggage);
    priced.breakdown.distanceSource = dist.distanceSource;
    priced.breakdown.durationMin = dist.durationMin;

    return res.json({
      ok: true,
      quote: {
        currency: 'AUD',
        total: priced.total,
        breakdown: priced.breakdown,
        pickup, dropoff, when, pax, luggage
      }
    });
  } catch (err) {
    console.error('quote error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// ----- boot -----
app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
});

