// server.js
'use strict';

const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

const app = express();
// Express middleware
function requireApiKey(req, res, next) {
  const expected = process.env.LMS_API_KEY;
  if (!expected) return next(); // not enforcing if unset
  if (req.get('X-Api-Key') !== expected) {
    return res.status(401).json({ ok:false, error:'Invalid API key' });
  }
  next();
}
const express = require('express');
const app = express();

app.use(express.json());

const REQUIRED_KEY = process.env.LMS_API_KEY;
if (!REQUIRED_KEY) {
  console.error('LMS_API_KEY is NOT set – requests will be rejected');
}

/** Enforce API key on ALL /api routes */
app.use('/api', (req, res, next) => {
  const key = req.get('x-api-key'); // headers are case-insensitive
  if (!REQUIRED_KEY || key !== REQUIRED_KEY) {
    return res.status(401).json({ ok: false, error: 'Invalid API key' });
  }
  next();
});

// …then your routes:
app.post('/api/quote', (req, res) => { /* existing handler */ });

/* -------------------- CORS (place FIRST) -------------------- */
const allowedOrigins = [
  'https://limomanagementsys.com.au',
  'https://www.limomanagementsys.com.au',
];

// Help caches vary on Origin so responses aren't mixed
app.use((req, res, next) => { res.setHeader('Vary', 'Origin'); next(); });

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // server-to-server / curl / PowerShell
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Requested-With'],
  credentials: false,
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

// Answer ALL preflights, then apply CORS
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

/* -------------------- Security / parsing / logs -------------------- */
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined'));

// If behind a proxy/CDN (Render/Cloudflare), trust the first proxy hop
app.set('trust proxy', 1);

/* -------------------- Rate limits -------------------- */
const limiterQuote = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 }); // 60 / 15m
const limiterBook  = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }); // 20 / 15m

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || '';
console.log('Google Maps key present:', Boolean(GOOGLE_MAPS_KEY));

async function getDistanceDurationKm(pickup, dropoff) {
  if (!GOOGLE_MAPS_KEY) return { ok: false, reason: 'no_key' };

  // hard cap to avoid proxy timeouts -> 5s
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), 5000);

  try {
    const params = new URLSearchParams({
      origins: pickup,
      destinations: dropoff,
      key: GOOGLE_MAPS_KEY,
      units: 'metric',
      region: 'au',
    });
    const url = 'https://maps.googleapis.com/maps/api/distancematrix/json?' + params.toString();

    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });

    if (!resp.ok) return { ok: false, reason: `http_${resp.status}` };
    const data = await resp.json();

    if (data.status !== 'OK') {
      return { ok: false, reason: `api_${data.status || 'unknown'}`, error_message: data.error_message };
    }
    const el = data.rows?.[0]?.elements?.[0];
    if (!el || el.status !== 'OK') return { ok: false, reason: `element_${el?.status || 'unknown'}` };

    const meters = Number(el.distance?.value || 0);
    const seconds = Number(el.duration?.value || 0);
    if (!meters || !seconds) return { ok: false, reason: 'missing_values' };

    return { ok: true, distanceKm: meters / 1000, durationMin: Math.round(seconds / 60) };
  } catch (err) {
    const r = err?.name === 'AbortError' ? 'timeout' : 'exception';
    console.warn('DistanceMatrix fetch error:', r, err?.message || err);
    return { ok: false, reason: r };
  } finally {
    clearTimeout(timeout);
  }
}

/* -------------------- Routes -------------------- */
app.get('/', (req, res) => {
  res.type('text/plain').send('Limo API up');
});

app.get('/api/ping', (req, res) => {
  res.json({ pong: true, at: new Date().toISOString(), mapsConfigured: Boolean(GOOGLE_MAPS_KEY) });
});

app.post('/api/quote', limiterQuote, async (req, res) => {
  const { pickup, dropoff, when, pax, luggage } = req.body || {};
  if (!pickup || !dropoff || !when) {
    return res.status(400).json({ ok: false, error: 'pickup, dropoff, and when are required' });
  }

  // Try Google first
  let distanceKm = null;
  let durationMin = null;
  let distanceSource = 'rough';

  const dm = await getDistanceDurationKm(pickup, dropoff);
  if (dm.ok) {
    distanceKm = dm.distanceKm;
    durationMin = dm.durationMin;
    distanceSource = 'google';
  } else {
    // Log once per request why we fell back (helps you debug in Render logs)
    console.warn('DistanceMatrix fallback:', dm.reason || 'unknown', dm.error_message ? `(${dm.error_message})` : '');
    // Simple placeholder rough distance (until Google succeeds)
    const roughDistance = Math.max(
      5,
      Math.min(45, Math.abs(String(pickup).length - String(dropoff).length) + 10)
    );
    distanceKm = roughDistance;
  }

  // Pricing
  const base = 65;
  const perKm = 2.2;
  const perPax = 5 * (Number(pax || 1) - 1);
  const perBag = 2 * Number(luggage || 0);

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
        durationMin: durationMin ?? null,
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
