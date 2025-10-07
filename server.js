const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const app = express();

// ----- config (env-driven) -----
const PORT = process.env.PORT || 4000;
// allow your WP site to call the API:
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || 'https://www.limomanagementsys.com.au';
// basic rate limits (adjust in Render env vars if needed):
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10); // 1 min
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '120', 10);               // 120 req/min

// ----- middleware -----
app.use(helmet());
app.use(morgan('combined'));
app.use(cors({ origin: [ALLOW_ORIGIN], credentials: true }));
app.use(express.json());

app.use(rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false
}));

// ----- routes -----
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/version', (_req, res) => res.json({ version: '1.0.0' }));
app.get('/', (_req, res) => res.send('Limo API is up ✅'));

// example API namespace (start adding real endpoints here)
app.get('/api/ping', (_req, res) => res.json({ pong: true, at: new Date().toISOString() }));

// ----- start -----
app.listen(PORT, '0.0.0.0', () => {
  console.log(`listening on ${PORT}`);
});

