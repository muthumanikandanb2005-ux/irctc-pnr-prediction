const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY  || '';
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'irctc-api2.p.rapidapi.com';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Use GET for a PNR lookup.' });
  }

  const pnr = typeof req.query.pnr === 'string' ? req.query.pnr.trim() : '';
  if (!/^\d{10}$/.test(pnr)) {
    return res.status(400).json({ error: 'Enter a valid 10-digit PNR number.' });
  }

  // ── Provider 1: RapidAPI IRCTC (primary) ─────────────────────────────────
  try {
    const rapidRes = await fetch(
      `https://${RAPIDAPI_HOST}/api/v1/getPNRStatus?pnrNumber=${pnr}`,
      {
        method: 'GET',
        headers: {
          'x-rapidapi-key':  RAPIDAPI_KEY,
          'x-rapidapi-host': RAPIDAPI_HOST,
          'Accept':          'application/json',
        },
        signal: AbortSignal.timeout(12000),
        cache:  'no-store',
      }
    );

    if (rapidRes.ok) {
      const json = await rapidRes.json();
      // The IRCTC RapidAPI returns { data: { ... } } on success
      if (json && (json.data || json.pnrNumber || json.trainNumber)) {
        return res.status(200).json({
          status:   'OK',
          pnr,
          data:     normalizeRapidAPI(json.data || json),
          provider: 'rapidapi-irctc',
        });
      }
    }
  } catch (_) {
    // fall through to backup provider
  }

  // ── Provider 2: pnrapi.dfth.in (backup) ──────────────────────────────────
  try {
    const backupRes = await fetch(`http://pnrapi.dfth.in/pnr/${pnr}`, {
      headers: { Accept: 'application/json' },
      signal:  AbortSignal.timeout(10000),
      cache:   'no-store',
    });

    if (backupRes.ok) {
      const json = await backupRes.json();
      if (json.status === 'OK' && json.data) {
        return res.status(200).json({
          status:   'OK',
          pnr,
          data:     normalizeBackup(json.data),
          provider: 'pnrapi-backup',
        });
      }
    }
  } catch (_) {
    // fall through to error
  }

  return res.status(502).json({
    error: 'Unable to fetch PNR status right now. Please try again or check IRCTC website / call 139.',
  });
}

// ─── Normalize RapidAPI IRCTC response ───────────────────────────────────────
function normalizeRapidAPI(d) {
  // Handle both camelCase and snake_case field names from RapidAPI
  const passengers = (d.passengerList || d.passenger_list || d.passengers || []).map((p, i) => ({
    number:         i + 1,
    booking_status: p.bookingStatus  || p.booking_status  || '',
    status:         p.currentStatus  || p.current_status  || p.bookingStatus || '',
    coach:          p.coachPosition  || p.coach_position  || p.coach || '',
    berth:          p.berthNo        || p.berth_no        || p.berth || '',
  }));

  return {
    train_name:     d.trainName       || d.train_name      || '',
    train_number:   d.trainNumber     || d.train_number    || '',
    travel_date:    d.dateOfJourney   || d.date_of_journey || d.doj || '',
    travel_class:   d.travelClass     || d.travel_class    || d.cls || '',
    quota:          d.quota           || 'GN',
    chart_prepared: d.chartPrepared   || d.chart_prepared  || false,
    departure_time: d.departureTime   || d.departure_time  || '',
    arrival_time:   d.arrivalTime     || d.arrival_time    || '',
    duration:       d.duration        || '',
    from: {
      code:     d.boardingPoint?.stationCode || d.from?.code     || d.boardingStationCode  || '',
      name:     d.boardingPoint?.stationName || d.from?.name     || d.boardingStationName  || '',
      dep_time: d.boardingPoint?.departureTime || d.from?.dep_time || '',
    },
    to: {
      code:     d.reservationUpTo?.stationCode || d.to?.code     || d.destinationStationCode  || '',
      name:     d.reservationUpTo?.stationName || d.to?.name     || d.destinationStationName  || '',
      arr_time: d.reservationUpTo?.arrivalTime || d.to?.arr_time || '',
    },
    passenger: passengers,
  };
}

// ─── Normalize backup pnrapi.dfth.in response ────────────────────────────────
function normalizeBackup(d) {
  return {
    train_name:     d.train_name   || d.trainName   || '',
    train_number:   d.train_number || d.trainNumber || '',
    travel_date:    d.travel_date  || d.doj         || '',
    travel_class:   d.travel_class || d.cls          || '',
    quota:          d.quota        || 'GN',
    chart_prepared: d.chart_prepared || false,
    departure_time: d.departure_time || '',
    arrival_time:   d.arrival_time   || '',
    duration:       d.duration       || '',
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
      number:         i + 1,
      booking_status: p.booking_status || p.bookingStatus || '',
      status:         p.current_status || p.status        || '',
      coach:          p.coach          || '',
      berth:          p.berth          || p.berthNo       || '',
    })),
  };
}
