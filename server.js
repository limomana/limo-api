'use strict';

// --- Optional: load .env locally (won't crash if not installed) ---
try { require('dotenv').config(); } catch (_) {}

// --- Core ---
const express = require('express');            // ← only once
const app = express();
app.use(express.json());

// --- Config / Env ---
const PORT       = process.env.PORT || 10000;
const API_KEY    = (process.env.LMS_API_KEY || '').trim();
const MAPS_KEY   = (process.env.GOOGLE_MAPS_KEY || '').trim();
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://limomanagementsys.com.au';

// One-time startup visibility (mask values)
console.log(
  'LMS_API_KEY present:', Boolean(API_KEY), 'len:', API_KEY.length,
  'GOOGLE_MAPS_KEY present:', Boolean(MAPS_KEY), 'len:', MAPS_KEY.length
);

// --- Minimal CORS (match your site) ---
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, LMS-Api-Key, X-Debug-ID');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- Health ---
app.get('/api/ping', (req, res) => {
  res.json({
    pong: true,
    at: new Date().toISOString(),
    mapsConfigured: Boolean(MAPS_KEY)
  });
});

// --- Helpers ---
function round2(n) { return Math.round(n * 100) / 100; }

function roughDistanceKm(pickup, dropoff) {
  // Simple fallback when no Google Maps key is configured or API fails.
  const p = (pickup || '').toLowerCase();
  const d = (dropoff || '').toLowerCase();

  // Your common lane:
  if (p.includes('brisbane airport') && d.includes('south bank') ||
      d.includes('brisbane airport') && p.includes('south bank')) {
    return 16; // matches earlier results
  }
  return 10;   // generic fallback
}

async function googleDistanceKmAndMinutes(pickup, dropoff) {
  // Uses Google Directions API (driving) via global fetch (Node 18+)
  const params = new URLSearchParams({
    origin: pickup,
    destination: dropoff,
    mode: 'driving',
    key: MAPS_KEY
  });
  const url = `https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Google HTTP ${resp.status}`);
  const data = await resp.json();

  if (!data.routes || !data.routes.length) {
    throw new Error('No routes returned');
  }
  const leg = data.routes[0].legs && data.routes[0].legs[0];
  if (!leg || !leg.distance || !leg.duration) {
    throw new Error('No legs/distance/duration');
  }
  const distanceKm  = leg.distance.value / 1000; // meters → km
  const durationMin = Math.round(leg.duration.value / 60); // seconds → minutes
  return { distanceKm, durationMin };
}

function priceQuote({ distanceKm, pax, luggage }) {
  // Pricing model:
  // base = 65
  // perKm = 2.2
  // perPax = 5 (for each pax *beyond the first*)
  // perBag = 2 (per bag)
  const base   = 65;
  const perKm  = 2.2;
  const perPax = 5;
  const perBag = 2;

  const extraPax = Math.max(0, (Number(pax) || 0) - 1);
  const bags     = Math.max(0, Number(luggage) || 0);

  const total = base + (perKm * distanceKm) + (perPax * extraPax) + (perBag * bags);
  return round2(total);
}

// --- Quote (auth enforced here) ---
app.post('/api/quote', async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({ ok: false, error: 'Server missing LMS_API_KEY' });
    }
    const incomingKey = (req.get('LMS-Api-Key') || '').trim();
    if (incomingKey !== API_KEY) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const { pickup, dropoff, when, pax, luggage } = req.body || {};

    if (!pickup || !dropoff) {
      return res.status(400).json({ ok: false, error: 'pickup and dropoff are required' });
    }

    // Distance lookup
    let distanceKm, durationMin, distanceSource;
    if (MAPS_KEY) {
      try {
        const g = await googleDistanceKmAndMinutes(pickup, dropoff);
        distanceKm   = g.distanceKm;
        durationMin  = g.durationMin;
        distanceSource = 'google';
      } catch (err) {
        console.warn('Google distance failed, falling back:', err.message);
        distanceKm = roughDistanceKm(pickup, dropoff);
        durationMin = null;
        distanceSource = 'rough';
      }
    } else {
      distanceKm = roughDistanceKm(pickup, dropoff);
      durationMin = null;
      distanceSource = 'rough';
    }

    const total = priceQuote({ distanceKm, pax, luggage });

    return res.json({
      ok: true,
      quote: {
        currency: 'AUD',
        total,
        breakdown: {
          base: 65,
          perKm: 2.2,
          distanceKm: round2(distanceKm),
          distanceSource,
          perPax: 5,
          perBag: 2,
          durationMin
        },
        pickup,
        dropoff,
        when,
        pax,
        luggage
      }
    });
  } catch (err) {
    console.error('Quote error:', err);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});
