const express = require('express');
const app = express();
const port = process.env.PORT || 4000; // Render supplies PORT
app.get('/', (req, res) => res.send('Limo app is up ✅'));
app.get('/health', (_, res) => res.send('ok'));
app.listen(port, '0.0.0.0', () => console.log('listening on', port));
