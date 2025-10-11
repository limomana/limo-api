'use strict';

// Exports a handler function: (req, res) => void/Promise
module.exports = async function quoteHandler(req, res) {
  try {
    const { pickup, dropoff, when, pax = 1, luggage = 0 } = req.body || {};
    if (!pickup || !dropoff || !when) {
      return res.status(400).json({ ok: false, error: 'Missing fields: pickup, dropoff, when' });
    }

    const paxNum = Number(pax) || 1;
    const bagNum = Number(luggage) || 0;

    // Try Google Distance Matrix if key is configured
    let distanceKm = null;
    let durationMin = null;
    let distanceSource = 'rough';

    if (process.env.GOOGLE_MAPS_API_KEY) {
      const params = new URLSearchParams({
        origins: pickup,
        destinations: dropoff,
        units: 'metric',
        departure_time: 'now',
        key: process.env.GOOGLE_MAPS_API_KEY,
      });
      const url = `https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`;

      const resp = await fetch(url);
      const data = await resp.json();
      const el = data?.rows?.[0]?.elements?.[0];
      if (el?.status === 'OK') {
        distanceKm = el.distance.value / 1000;
        durationMin = Math.round(el.duration.value / 60);
        distanceSource = 'google';
      }
    }

    // Fallback if Google not configured or fails
    if (distanceKm == null) {
      if (
        (/brisbane airport/i.test(pickup) && /south bank/i.test(dropoff)) ||
        (/south bank/i.test(pickup) && /brisbane airport/i.test(dropoff))
      ) {
        distanceKm = 16;
      } else {
        distanceKm = 10; // generic fallback
      }
    }

    // Pricing (matches your earlier quotes)
    const base = 65;
    const perKm = 2.2;
    const perPax = 5;      // per additional passenger over 1
    const perBag = 2;

    const total =
      round2(base + perKm * distanceKm + perPax * Math.max(0, paxNum - 1) + perBag * bagNum);

    return res.json({
      ok: true,
      quote: {
        currency: 'AUD',
        total: round2(total),
        breakdown: {
          base,
          perKm,
          distanceKm: round2(distanceKm),
          distanceSource,
          perPax,
          perBag,
          durationMin,
        },
        pickup,
        dropoff,
        when,
        pax: paxNum,
        luggage: bagNum,
      },
    });
  } catch (err) {
    console.error('quote error', err);
    return res.status(500).json({ ok: false, error: 'Quote failed' });
  }
};

function round2(x) {
  return Math.round(x * 100) / 100;
}
