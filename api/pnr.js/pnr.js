export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET for a PNR lookup.' });

  const pnr = typeof req.query.pnr === 'string' ? req.query.pnr.trim() : '';
  if (!/^\d{10}$/.test(pnr)) {
    return res.status(400).json({ error: 'Enter a valid 10-digit PNR number.' });
  }

  // Try multiple API providers for reliability
  const providers = [
    `http://pnrapi.dfth.in/pnr/${pnr}`,
    `https://api.railwayapi.com/v2/pnr-status/pnr/${pnr}/apikey/demo/`,
  ];

  for (const url of providers) {
    try {
      const upstream = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; PNRTracker/2.0)',
        },
        signal: AbortSignal.timeout(10000),
        cache: 'no-store',
      });

      if (!upstream.ok) continue;

      const result = await upstream.json();

      // Normalize response from provider 1 (pnrapi.dfth.in)
      if (result.status === 'OK' && result.data) {
        return res.status(200).json({
          status: 'OK',
          pnr,
          data: normalizeData(result.data),
          provider: 'pnrapi',
        });
      }

      // Normalize response from provider 2 (railwayapi)
      if (result.response_code === 200 && result.train) {
        return res.status(200).json({
          status: 'OK',
          pnr,
          data: normalizeRailwayApi(result),
          provider: 'railwayapi',
        });
      }
    } catch (_) {
      // Try next provider
      continue;
    }
  }

  return res.status(502).json({
    error: 'All PNR providers are currently unavailable. Please try again in a moment or check via IRCTC official website.',
  });
}

/**
 * Normalize pnrapi.dfth.in response shape
 */
function normalizeData(d) {
  return {
    train_name:    d.train_name    || d.trainName    || '',
    train_number:  d.train_number  || d.trainNumber  || '',
    travel_date:   d.travel_date   || d.doj          || '',
    travel_class:  d.travel_class  || d.cls           || '',
    quota:         d.quota         || 'GN',
    duration:      d.duration      || '',
    departure_time: d.departure_time || '',
    arrival_time:   d.arrival_time   || '',
    from: {
      code:     d.from?.code     || d.boarding_point || '',
      name:     d.from?.name     || '',
      dep_time: d.from?.dep_time || '',
    },
    to: {
      code:     d.to?.code     || d.destination || '',
      name:     d.to?.name     || '',
      arr_time: d.to?.arr_time || '',
    },
    passenger: (d.passenger || []).map((p, i) => ({
      number:          i + 1,
      booking_status:  p.booking_status  || p.bookingStatus  || '',
      current_status:  p.current_status  || p.status         || '',
      status:          p.current_status  || p.status         || '',
      coach:           p.coach           || '',
      berth:           p.berth           || p.berthNo        || '',
    })),
    chart_prepared: d.chart_prepared || d.chartPrepared || false,
  };
}

/**
 * Normalize railwayapi.com response shape
 */
function normalizeRailwayApi(r) {
  const train = r.train || {};
  const from  = r.journey?.boarding_point || r.from_station || {};
  const to    = r.journey?.reservation_upto || r.to_station   || {};
  return {
    train_name:    train.name   || '',
    train_number:  train.number || '',
    travel_date:   r.doj        || '',
    travel_class:  r.cls        || '',
    quota:         r.quota      || 'GN',
    from: { code: from.code || '', name: from.name || '', dep_time: from.departure || '' },
    to:   { code: to.code   || '', name: to.name   || '', arr_time: to.arrival    || '' },
    passenger: (r.passengers || []).map((p, i) => ({
      number:         i + 1,
      booking_status: p.booking_status || '',
      status:         p.current_status || '',
      coach:          p.coach          || '',
      berth:          p.berth_no       || '',
    })),
    chart_prepared: r.chart_prepared || false,
  };
}
