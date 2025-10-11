// server.js  — CommonJS (no "type": "module" in package.json)
'use strict';

// ---- Imports (declare ONCE)
const express = require('express');
const cors = require('cors');

// ---- App
const app = express();
const PORT = process.env.PORT || 10000;

// Useful if behind a proxy (Render)
app.set('trust proxy', 1);

// ---- Core middleware (declare ONCE)
app.use(express.json());

// CORS: allow your WP front-end & the app domain
app.use(
  cors({
    origin: [
      'https://limomanagementsys.com.au',
      'https://www.limomanagementsys.com.au',
      'https://app.limomanagementsys.com.au',
    ],
  })
);

// Optional: attach request id for quick log correlation
app.use((req, _res, next) => {
  req.debugId = req.get('X-Debug-ID') || '';
  next();
});

// ---- API key guard (enable only if LMS_API_KEY is set)
app.use((req, res, next) => {
  const requiredKey = process.env.LMS_API_KEY;
  if (!requiredKey) return next(); // no key set -> bypass
  const provided = req.get('X-Api-Key');
  if (provided !== requiredKey) {
    return res.status(401).json({ ok: false, error: 'Invalid API key' });
  }
  next();
});

// ---- Health
app.get('/api/ping', (req, res) => {
  res.json({
    pong: true,
    at: new Date().toISOString(),
    mapsConfigured: !!process.env.GOOGLE_MAPS_API_KEY,
  });
});

// ---- Quote route
// Prefer your existing handler in ./routes/quote.js
//   module.exports = function handler(req, res) { ... }
let quoteMounted = false;
try {
  const quoteHandler = require('./routes/quote');
  if (typeof quoteHandler === 'function') {
    app.post('/api/quote', quoteHandler);
    quoteMounted = true;
    console.log('Mounted /api/quote from routes/quote.js');
  } else if (quoteHandler && typeof quoteHandler.default === 'function') {
    app.post('/api/quote', quoteHandler.default);
    quoteMounted = true;
    console.log('Mounted /api/quote from routes/quote.js (default export)');
  }
} catch (err) {
  console.warn('No ./routes/quote.js found; using fallback 501 handler.');
}

// Fallback (only if no handler was mounted)
if (!quoteMounted) {
  app.post('/api/quote', (req, res) => {
    return res.status(501).json({
      ok: false,
      error:
        'Quote handler not attached. Create ./routes/quote.js and export a function (req, res) to handle /api/quote.',
      sample: {
        pickup: 'Brisbane Airport',
        dropoff: 'South Bank',
        when: '2025-10-15T10:30',
        pax: 2,
        luggage: 1,
      },
    });
  });
}

// ---- 404 for unknown API routes
app.use('/api/*', (_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

// ---- Error handler
app.use((err, req, res, _next) => {
  console.error(`[${req.debugId}]`, err);
  res.status(500).json({ ok: false, error: 'Server error' });
});

// ---- Start
app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
});
