// server.js
'use strict';

const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

const app = express();

/* -------------------- Env -------------------- */
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || null;

/* -------------------- CORS (place FIRST) -------------------- */
const allowedOrigins = [
  'https://limomanagementsys.com.au',
  'https://www.limomanagementsys.com.au',
];

// help caches vary on Origin so responses aren't mixed
app.use((req, res, next) => { res.setHeader('Vary', 'Origin'); next(); });

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // server-to-server / curl
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Requested-With'],
  credentials: false,
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

// answer ALL preflights, then apply CORS
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

/* -------------------- Security / parsing / logs -------------------- */
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined'));

// if behind a proxy/CDN (Render/Cloudflare), trust the first proxy hop
app.set('trust proxy', 1);

/* -------------------- Rate limits -------------------- */
const limiterQuote = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 }); // 60 / 15m
const limiterBook  = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }); // 20 / 15m

/* -------------------- Distance helpers (Google Distance Matrix) -------------------- */
async function fetchJsonWithTimeout(url, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, data: null };
  }
}

async function getDistanceKmAndMinutes(pickup, dropoff) {
  if (!GOOGLE_MAPS_KEY) return null;

  const url =
    'https://maps.googleapis.com/maps/api/distancematrix/json' +
    `?units=metric&origins=${encodeURIComponent(pickup)}` +
    `&destinations=${encodeURIComponent(dropoff)}` +
    `&departure_time=now&key=${GOOGLE_MAPS_KEY}`;

  const { ok, data } = await fetchJsonWithTimeout(url, 7000);
  if (!ok || !data || data.status !== 'OK') return null;

  const el = data?.rows?.[0]?.elements?.[0];
  if (!el || el.status !== 'OK') return null;

  const km = el.distance.value / 1000;
  const minutes = Math.round(((el.duration_in_traffic?.value ?? el.duration?.value) || 0) / 60);
  return { km, minutes };
}

/* -------------------- Routes -------------------- */
app.get('/', (req, res) => {
  res.type('text/plain').send('Limo API up');
});

app.get('/api/ping', (req, res) => {
  res.json({ pong: true, at: new Date().toISOString() });
});

app.post('/api/quote', limiterQuote, async (req, res) => {
  const { pickup, dropoff, when, pax, luggage } = req.body || {};
  if (!pickup || !dropoff || !when) {
    return res.status(400).json({ ok: false, error: 'pickup, dropoff, and when are required' });
  }

  // Pricing knobs
  const base = 65;
  const perKm = 2.2;
  const perPax = 5 * (Number(pax || 1) - 1);
  const perBag = 2 * Number(luggage || 0);

  // Try Google first; fall back to rough estimate
  let distanceKm = null;
  let durationMin = null;
  let distanceSource = 'rough';

  try {
    const dm = await getDistanceKmAndMinutes(pickup, dropoff);
    if (dm) {
      distanceKm = dm.km;
      durationMin = dm.minutes;
      distanceSource = 'google';
    }
  } catch (_) {
    // swallow; we'll use fallback below
  }

  if (distanceKm == null || !Number.isFinite(distanceKm)) {
    const roughDistance = Math.max(
      5,
      Math.min(45, Math.abs(String(pickup).length - String(dropoff).length) + 10)
    );
    distanceKm = roughDistance;
  }

  const total = Math.round((base + perKm * distanceKm + perPax + perBag) * 100) / 100;

  return res.json({
    ok: true,
    quote: {
      currency: 'AUD',
      total,
      breakdown: {
        base,
        perKm,
        distanceKm,
        distanceSource,
        perPax,
        perBag,
        durationMin,
      },
      pickup,
      dropoff,
      when,
      pax: Number(pax || 1),
      luggage: Number(luggage || 0),
    },
  });
});

app.post('/api/book', limiterBook, (req, res) => {
  const { quoteRef, pickup, dropoff, when, pax, luggage, name, email, phone, notes } = req.body || {};
  if (!pickup || !dropoff || !when || !name || !phone) {
    return res.status(400).json({ ok: false, error: 'pickup, dropoff, when, name, phone are required' });
  }
  const id = 'LM-' + Math.random().toString(36).slice(2, 8).toUpperCase();

  return res.status(201).json({
    ok: true,
    booking: {
      id,
      quoteRef: quoteRef || null,
      pickup,
      dropoff,
      when,
      pax: Number(pax || 1),
      luggage: Number(luggage || 0),
      name,
      email: email || null,
      phone,
      notes: notes || null,
      createdAt: new Date().toISOString(),
    },
  });
});

/* -------------------- 404 + error handlers -------------------- */
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

app.use((err, req, res, next) => {
  // Handle CORS denials cleanly
  if (err && err.message && /CORS/i.test(err.message)) {
    return res.status(403).json({ ok: false, error: 'CORS: origin not allowed' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

/* -------------------- Listen -------------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`API listening on ${PORT}`));
