// server.js
'use strict';

const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

const app = express();

/* -------------------- CORS (place FIRST) -------------------- */
const allowedOrigins = [
  'https://limomanagementsys.com.au',
  'https://www.limomanagementsys.com.au',
];
app.use((req, res, next) => { res.setHeader('Vary', 'Origin'); next(); });

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Requested-With'],
  credentials: false,
  preflightContinue: false,
  optionsSuccessStatus: 204,
};
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

/* -------------------- Security / parsing / logs -------------------- */
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined'));
app.set('trust proxy', 1);

/* -------------------- Rate limits -------------------- */
const limiterQuote = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });
const limiterBook  = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

/* -------------------- Pricing & Google config -------------------- */
const GMAPS_KEY = process.env.GOOGLE_MAPS_KEY || process.env.GMAPS_KEY;

const PRICING = {
  base:   Number(process.env.PRICE_BASE     || 65),
  perKm:  Number(process.env.PRICE_PER_KM   || 2.2),
  perMin: Number(process.env.PRICE_PER_MIN  || 0.8),
  perPax: Number(process.env.PRICE_PER_PAX  || 5),
  perBag: Number(process.env.PRICE_PER_BAG  || 2),
};

const SURCHARGES = {
  afterHoursStart: process.env.AFTER_HOURS_START || '22:00',
  afterHoursEnd:   process.env.AFTER_HOURS_END   || '05:00',
  afterHoursRate:  Number(process.env.AFTER_HOURS_RATE || 0.10),
  airportFee:      Number(process.env.AIRPORT_SURCHARGE || 0),
};

// very small 12h in-memory cache for distance matrix results
const _cache = new Map();
const _TTL_MS = 12 * 60 * 60 * 1000;
const _key = (a,b) => `${a}||${b}`.toLowerCase();
const _get = (a,b) => {
  const v = _cache.get(_key(a,b));
  if (!v) return null;
  if (Date.now()-v.t > _TTL_MS) { _cache.delete(_key(a,b)); return null; }
  return v.data;
};
const _set = (a,b,data) => _cache.set(_key(a,b), { t: Date.now(), data });

function isAfterHours(dtISO){
  try {
    const d = dtISO ? new Date(dtISO) : new Date();
    const [sH,sM] = (process.env.TZ ? SURCHARGES.afterHoursStart : SURCHARGES.afterHoursStart).split(':').map(Number);
    const [eH,eM] = SURCHARGES.afterHoursEnd.split(':').map(Number);
    const mins = d.getHours()*60 + d.getMinutes();
    const start = sH*60 + sM, end = eH*60 + eM;
    return start <= end ? (mins >= start && mins < end) : (mins >= start || mins < end);
  } catch { return false; }
}
const looksLikeAirport = s => /airport|bne|brisbane\s*airport/i.test(String(s||''));

/* -------------------- Routes -------------------- */
app.get('/', (_, res) => res.type('text/plain').send('Limo API up'));
app.get('/api/ping', (_, res) => res.json({ pong: true, at: new Date().toISOString() }));

app.post('/api/quote', limiterQuote, async (req, res) => {
  const { pickup, dropoff, when, pax, luggage } = req.body || {};
  if (!pickup || !dropoff || !when) {
    return res.status(400).json({ ok: false, error: 'pickup, dropoff, and when are required' });
  }

  let km = null, mins = null, source = 'cache';
  const cached = _get(pickup, dropoff);
  if (cached) { km = cached.km; mins = cached.mins; }

  if (!km || !mins) {
    try {
      if (!GMAPS_KEY) throw new Error('Missing GOOGLE_MAPS_KEY');
      const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
      url.searchParams.set('origins', pickup);
      url.searchParams.set('destinations', dropoff);
      url.searchParams.set('mode', 'driving');
      url.searchParams.set('departure_time', 'now');
      url.searchParams.set('key', GMAPS_KEY);

      const resp = await fetch(url.toString());
      const data = await resp.json();
      const el = data?.rows?.[0]?.elements?.[0];
      if (resp.ok && el && el.status === 'OK') {
        const meters  = Number(el.distance?.value || 0);
        const seconds = Number((el.duration_in_traffic || el.duration)?.value || 0);
        km   = meters / 1000;
        mins = seconds / 60;
        source = 'google';
        _set(pickup, dropoff, { km, mins });
        console.log(`matrix ok: ${km.toFixed(1)} km, ${Math.round(mins)} min`);
      } else {
        throw new Error(`Matrix error: ${el?.status || data?.status || resp.status}`);
      }
    } catch (e) {
      console.error('Distance Matrix failed, using fallback:', e.message);
      // fallback: older rough estimate
      const roughDistance = Math.max(5,
        Math.min(45, Math.abs(String(pickup).length - String(dropoff).length) + 10));
      km = roughDistance;
      mins = roughDistance * 2;
      source = 'fallback';
    }
  }

  // price
  const pPax = PRICING.perPax * Math.max(0, Number(pax || 1) - 1);
  const pBag = PRICING.perBag * Math.max(0, Number(luggage || 0));
  const base = PRICING.base;
  const perKmCost  = PRICING.perKm  * km;
  const perMinCost = PRICING.perMin * mins;

  let subtotal = base + perKmCost + perMinCost + pPax + pBag;
  let surcharges = {};

  if (isAfterHours(when)) {
    const extra = subtotal * SURCHARGES.afterHoursRate;
    subtotal += extra;
    surcharges.afterHours = Math.round(extra * 100) / 100;
  }
  if (SURCHARGES.airportFee && (looksLikeAirport(pickup) || looksLikeAirport(dropoff))) {
    subtotal += SURCHARGES.airportFee;
    surcharges.airport = SURCHARGES.airportFee;
  }

  const total = Math.round(subtotal * 100) / 100;

  return res.json({
    ok: true,
    quote: {
      currency: 'AUD',
      total,
      distance_km: Math.round(km * 100) / 100,
      duration_min: Math.round(mins),
      source,
      breakdown: {
        base: PRICING.base,
        perKm: PRICING.perKm,
        perMin: PRICING.perMin,
        perPax: PRICING.perPax,
        perBag: PRICING.perBag,
        components: {
          base,
          perKm: Math.round(perKmCost * 100) / 100,
          perMin: Math.round(perMinCost * 100) / 100,
          pPax,
          pBag,
          ...surcharges
        }
      },
      pickup, dropoff, when,
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
      id, quoteRef: quoteRef || null,
      pickup, dropoff, when,
      pax: Number(pax || 1),
      luggage: Number(luggage || 0),
      name, email: email || null, phone, notes: notes || null,
      createdAt: new Date().toISOString(),
    },
  });
});

/* -------------------- 404 + error handlers -------------------- */
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err && err.message && /CORS/i.test(err.message)) {
    return res.status(403).json({ ok: false, error: 'CORS: origin not allowed' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

/* -------------------- Listen -------------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`API listening on ${PORT}`));
