import { configure, checkPNRStatus } from 'railkit';

const RAILKIT_API_KEY = process.env.RAILKIT_API_KEY || 'railkit_696fed7d3cfa2c883f874d1207a8d611e55ab68cbc9052f0';
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '7e8ea2dc25mshd7301594920ea87p1c316ejsn08e58b484aad';
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'irctc-api2.p.rapidapi.com';

// Initialize RailKit SDK with API key
if (RAILKIT_API_KEY) {
  try {
    configure(RAILKIT_API_KEY);
  } catch (err) {
    console.error('RailKit configuration error:', err);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  const pnr = typeof req.query.pnr === 'string' ? req.query.pnr.trim() : '';
  if (!/^\d{10}$/.test(pnr)) {
    return res.status(400).json({ error: 'Please enter a valid 10-digit Indian Railways PNR number.' });
  }

  let lastError = null;

  // ── Engine 1: RailKit SDK (Primary) ───────────────────────────────────────
  if (RAILKIT_API_KEY) {
    try {
      const rkRes = await checkPNRStatus(pnr);
      if (rkRes && rkRes.success && rkRes.data) {
        return res.status(200).json({
          status: 'OK',
          pnr,
          provider: 'railkit',
          data: normalizeRailKit(rkRes.data, pnr)
        });
      }
      if (rkRes && (rkRes.error || rkRes.message)) {
        lastError = rkRes.error || rkRes.message;
      }
    } catch (err) {
      console.warn('RailKit failed, trying fallback:', err.message);
      lastError = err.message;
    }
  }

  // ── Engine 2: RapidAPI IRCTC (Secondary) ──────────────────────────────────
  if (RAPIDAPI_KEY) {
    try {
      const resp = await fetch(`https://${RAPIDAPI_HOST}/pnrStatus?pnr=${pnr}`, {
        method: 'GET',
        headers: {
          'x-rapidapi-host': RAPIDAPI_HOST,
          'x-rapidapi-key': RAPIDAPI_KEY,
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(12000),
        cache: 'no-store'
      });

      if (resp.ok) {
        const rapidJson = await resp.json();
        if (rapidJson && rapidJson.success && rapidJson.data) {
          return res.status(200).json({
            status: 'OK',
            pnr,
            provider: 'rapidapi-irctc',
            data: normalizeRapidAPI(rapidJson.data, pnr)
          });
        }
        if (rapidJson && (rapidJson.message || rapidJson.error)) {
          lastError = rapidJson.message || rapidJson.error;
        }
      }
    } catch (err) {
      console.warn('RapidAPI failed:', err.message);
      lastError = err.message;
    }
  }

  // ── Engine 3: Backup Service ──────────────────────────────────────────────
  try {
    const backupRes = await fetch(`http://pnrapi.dfth.in/pnr/${pnr}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
      cache: 'no-store'
    });

    if (backupRes.ok) {
      const backupJson = await backupRes.json();
      if (backupJson && backupJson.status === 'OK' && backupJson.data) {
        return res.status(200).json({
          status: 'OK',
          pnr,
          provider: 'pnrapi-backup',
          data: normalizeBackup(backupJson.data, pnr)
        });
      }
    }
  } catch (err) {
    console.warn('Backup failed:', err.message);
  }

  // If no provider succeeded
  const message = lastError || 'PNR details not found. The ticket may have expired or was cancelled.';
  return res.status(404).json({
    status: 'ERROR',
    error: message
  });
}

// ── Berth code translator ───────────────────────────────────────────────────
function getBerthTitle(code) {
  if (!code) return '';
  const map = {
    WS: 'Window Seat',
    LB: 'Lower Berth',
    MB: 'Middle Berth',
    UB: 'Upper Berth',
    SL: 'Side Lower',
    SU: 'Side Upper',
    SM: 'Side Middle',
    AS: 'Aisle Seat',
    MS: 'Middle Seat',
    W: 'Window Seat'
  };
  return map[code.toUpperCase()] || code;
}

// ── Status classifier ───────────────────────────────────────────────────────
function classifyStatus(statusStr) {
  if (!statusStr) return { type: 'WL', raw: 'WL' };
  const s = String(statusStr).toUpperCase();
  if (s.includes('CNF') || s.includes('CONFIRM')) return { type: 'CNF', raw: statusStr };
  if (s.includes('RAC')) return { type: 'RAC', raw: statusStr };
  if (s.includes('CAN') || s.includes('CANCEL')) return { type: 'CAN', raw: statusStr };
  return { type: 'WL', raw: statusStr };
}

// ── Parse Date and Time Strings ─────────────────────────────────────────────
function parseDateTimeStr(str) {
  if (!str) return { date: '', time: '', raw: '' };
  try {
    const d = new Date(str);
    if (!isNaN(d.getTime())) {
      const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
      return { date, time, raw: str };
    }
  } catch (_) {}
  return { date: str, time: '', raw: str };
}

// ── Calculate duration between dates ────────────────────────────────────────
function calcDuration(startStr, endStr) {
  if (!startStr || !endStr) return '';
  try {
    const start = new Date(startStr);
    const end = new Date(endStr);
    if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
      const diffMins = Math.round((end - start) / 60000);
      if (diffMins > 0) {
        const h = Math.floor(diffMins / 60);
        const m = diffMins % 60;
        return `${h}h ${m}m`;
      }
    }
  } catch (_) {}
  return '';
}

// ── Normalize RailKit response ──────────────────────────────────────────────
function normalizeRailKit(d, pnr) {
  const train = d.train || {};
  const journey = d.journey || {};
  const booking = d.booking || {};
  const chart = d.chart || {};
  const passengersRaw = Array.isArray(d.passengers) ? d.passengers : [];

  const depParsed = parseDateTimeStr(journey.dateOfJourney);
  const arrParsed = parseDateTimeStr(journey.arrivalDate);
  const duration = calcDuration(journey.dateOfJourney, journey.arrivalDate);

  const passengers = passengersRaw.map((p, i) => {
    const cur = p.current || {};
    const bkg = p.booking || {};
    const curDetails = cur.details || (cur.status ? `${cur.status}${cur.coach ? ' ' + cur.coach : ''}${cur.berthNo ? ' ' + cur.berthNo : ''}` : '') || '';
    const bkgDetails = bkg.details || (bkg.status ? `${bkg.status}${bkg.coach ? ' ' + bkg.coach : ''}${bkg.berthNo ? ' ' + bkg.berthNo : ''}` : '') || '';
    const st = classifyStatus(curDetails || cur.status || bkgDetails);
    const berthCode = cur.berthCode || bkg.berthCode || '';

    return {
      number: i + 1,
      booking_status: bkgDetails || bkg.status || 'CNF',
      current_status: curDetails || cur.status || bkgDetails || 'CNF',
      status: cur.status || bkg.status || 'CNF',
      status_type: st.type,
      coach: cur.coach || bkg.coach || null,
      berth: cur.berthNo || bkg.berthNo || null,
      berth_code: berthCode,
      berth_name: getBerthTitle(berthCode)
    };
  });

  return {
    pnr,
    train_number: train.number || '',
    train_name: train.name || '',
    travel_date: depParsed.date || journey.dateOfJourney || '',
    travel_time: depParsed.time || '',
    arrival_date: arrParsed.date || journey.arrivalDate || '',
    arrival_time: arrParsed.time || '',
    duration: duration,
    travel_class: journey.class || '',
    quota: journey.quota || 'GN',
    distance: journey.distance ? `${journey.distance} km` : '',
    from: {
      code: journey.source?.code || '',
      name: journey.source?.name || journey.source?.code || '',
      dep_time: depParsed.time || ''
    },
    to: {
      code: journey.destination?.code || '',
      name: journey.destination?.name || journey.destination?.code || '',
      arr_time: arrParsed.time || ''
    },
    boarding: {
      code: journey.boardingPoint?.code || journey.source?.code || '',
      name: journey.boardingPoint?.name || journey.source?.name || ''
    },
    chart_status: chart.status || 'Chart Not Prepared',
    chart_prepared: (chart.status || '').toLowerCase().includes('prepared') && !(chart.status || '').toLowerCase().includes('not'),
    fare: {
      total: booking.fare || booking.ticketFare || '',
      formatted: booking.fare ? `₹${Number(booking.fare).toLocaleString('en-IN')}` : ''
    },
    ratings: null,
    has_pantry: false,
    passengers
  };
}

// ── Normalize RapidAPI response ─────────────────────────────────────────────
function normalizeRapidAPI(d, pnr) {
  const passengersRaw = Array.isArray(d.passengers) ? d.passengers : [];

  const passengers = passengersRaw.map((p, i) => {
    const curStatus = p.currentStatus || p.bookingStatus || '';
    const bkgStatus = p.bookingStatus || '';
    const st = classifyStatus(curStatus);

    return {
      number: p.number || i + 1,
      booking_status: bkgStatus,
      current_status: curStatus,
      status: curStatus,
      status_type: st.type,
      coach: p.coach || null,
      berth: p.berth || null,
      berth_code: '',
      berth_name: ''
    };
  });

  return {
    pnr: d.pnr || pnr,
    train_number: d.trainNumber || '',
    train_name: d.trainName || '',
    travel_date: d.journeyDate || '',
    travel_time: d.departureTime || '',
    arrival_date: '',
    arrival_time: d.arrivalTime || '',
    travel_class: d.class || '',
    quota: 'GN',
    distance: '',
    duration: d.duration ? `${d.duration} hrs` : '',
    from: {
      code: d.source || d.boardingPoint || '',
      name: d.source || '',
      dep_time: d.departureTime || ''
    },
    to: {
      code: d.destination || '',
      name: d.destination || '',
      arr_time: d.arrivalTime || ''
    },
    boarding: {
      code: d.boardingPoint || d.source || '',
      name: d.boardingPoint || ''
    },
    chart_status: d.chartPrepared ? 'Chart Prepared' : 'Chart Not Prepared',
    chart_prepared: Boolean(d.chartPrepared),
    fare: {
      total: d.fare?.bookingFare || d.fare?.ticketFare || '',
      formatted: d.fare?.bookingFare ? `₹${Number(d.fare.bookingFare).toLocaleString('en-IN')}` : ''
    },
    ratings: d.ratings || null,
    has_pantry: Boolean(d.hasPantry),
    passengers
  };
}

// ── Normalize pnrapi backup ─────────────────────────────────────────────────
function normalizeBackup(d, pnr) {
  const passengersRaw = Array.isArray(d.passenger) ? d.passenger : [];

  const passengers = passengersRaw.map((p, i) => {
    const stStr = p.status || p.booking_status || '';
    const st = classifyStatus(stStr);
    return {
      number: i + 1,
      booking_status: p.booking_status || '',
      current_status: p.status || '',
      status: p.status || '',
      status_type: st.type,
      coach: p.coach || null,
      berth: p.berth || null,
      berth_code: '',
      berth_name: ''
    };
  });

  return {
    pnr,
    train_number: d.train_number || '',
    train_name: d.train_name || '',
    travel_date: d.travel_date || '',
    travel_time: d.from?.dep_time || '',
    arrival_date: '',
    arrival_time: d.to?.arr_time || '',
    travel_class: d.travel_class || '',
    quota: d.quota || 'GN',
    distance: '',
    duration: d.duration || '',
    from: {
      code: d.from?.code || '',
      name: d.from?.name || '',
      dep_time: d.from?.dep_time || ''
    },
    to: {
      code: d.to?.code || '',
      name: d.to?.name || '',
      arr_time: d.to?.arr_time || ''
    },
    boarding: {
      code: d.boarding_point || d.from?.code || '',
      name: d.from?.name || ''
    },
    chart_status: d.chart_prepared ? 'Chart Prepared' : 'Chart Not Prepared',
    chart_prepared: Boolean(d.chart_prepared),
    fare: { total: '', formatted: '' },
    ratings: null,
    has_pantry: false,
    passengers
  };
}
