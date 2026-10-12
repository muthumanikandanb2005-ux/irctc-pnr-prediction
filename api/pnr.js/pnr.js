import {
  configure,
  checkPNRStatus,
  trackTrain,
  trackTrainV2,
  searchTrainBetweenStations,
  getTrainInfo,
  liveAtStation,
  stationsByName,
  trainsByName
} from 'railkit';

const RAILKIT_API_KEY = process.env.RAILKIT_API_KEY || 'railkit_696fed7d3cfa2c883f874d1207a8d611e55ab68cbc9052f0';
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '7e8ea2dc25mshd7301594920ea87p1c316ejsn08e58b484aad';
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'irctc-api2.p.rapidapi.com';

if (RAILKIT_API_KEY) {
  try {
    configure(RAILKIT_API_KEY);
  } catch (err) {
    console.error('RailKit configuration error:', err);
  }
}

function getTodayIST() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + istOffset);
  const day = String(istDate.getDate()).padStart(2, '0');
  const month = String(istDate.getMonth() + 1).padStart(2, '0');
  const year = istDate.getFullYear();
  return `${day}-${month}-${year}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  const action = typeof req.query.action === 'string' ? req.query.action.trim() : '';

  // ── ROUTE 1: Live Train Running Status (Where is My Train) ────────────────
  if (action === 'live') {
    const train = typeof req.query.train === 'string' ? req.query.train.trim() : '';
    let date = typeof req.query.date === 'string' ? req.query.date.trim() : '';
    if (!/^\d{4,5}$/.test(train)) {
      return res.status(400).json({ error: 'Please enter a valid 5-digit train number.' });
    }
    if (!date) date = getTodayIST();

    try {
      let liveRes;
      try {
        liveRes = await trackTrain(train, date);
      } catch (_) {
        liveRes = await trackTrainV2(train, date);
      }

      if (liveRes && liveRes.success && liveRes.data) {
        const d = liveRes.data;
        const timelineRaw = Array.isArray(d.timeline) ? d.timeline : [];
        const stoppages = timelineRaw.filter(t => t.type === 'stoppage' || t.platform || t.arrival);

        return res.status(200).json({
          status: 'OK',
          action: 'live',
          data: {
            train_no: d.trainNo || train,
            train_name: d.trainName || '',
            date: d.date || date,
            status_note: d.statusNote || 'Running on track',
            last_update: d.lastUpdate || '',
            speed: d.averageSpeedKmph ? `${d.averageSpeedKmph} km/h` : '',
            total_distance: d.totalDistanceKm ? `${d.totalDistanceKm} km` : '',
            journey_status: d.progress?.journeyStatus || '',
            current_station_code: d.currentStationCode || '',
            total_stoppages: d.totalStoppageStations || stoppages.length,
            timeline: timelineRaw.map(s => ({
              type: s.type || 'stoppage',
              status: s.status || '',
              station_code: s.stationCode || '',
              station_name: s.stationName || s.stationCode || '',
              platform: s.platform || '',
              distance_km: s.distanceKm || '',
              scheduled_arr: s.arrival?.scheduled || '',
              actual_arr: s.arrival?.actual || '',
              delay_arr: s.arrival?.delay || '',
              scheduled_dep: s.departure?.scheduled || '',
              actual_dep: s.departure?.actual || '',
              delay_dep: s.departure?.delay || ''
            }))
          }
        });
      }
      return res.status(404).json({
        error: liveRes?.error || `Live tracking data not available for train #${train} on ${date}.`
      });
    } catch (err) {
      return res.status(500).json({ error: `Failed to fetch train running status: ${err.message}` });
    }
  }

  // ── ROUTE 2: Search Trains Between Stations ───────────────────────────────
  if (action === 'search') {
    const from = typeof req.query.from === 'string' ? req.query.from.trim().toUpperCase() : '';
    const to = typeof req.query.to === 'string' ? req.query.to.trim().toUpperCase() : '';
    const date = typeof req.query.date === 'string' ? req.query.date.trim() : '';

    if (!from || !to) {
      return res.status(400).json({ error: 'Please provide both From and To station codes.' });
    }

    try {
      const searchRes = await searchTrainBetweenStations(from, to, date || undefined);
      if (searchRes && searchRes.success) {
        const trainsRaw = Array.isArray(searchRes.data?.trains)
          ? searchRes.data.trains
          : Array.isArray(searchRes.data)
            ? searchRes.data
            : [];

        const trains = trainsRaw.map(t => ({
          train_no: t.train_no || t.trainNo || '',
          train_name: t.train_name || t.trainName || '',
          from_code: t.from_stn_code || t.from || from,
          from_name: t.from_stn_name || t.fromName || from,
          from_time: t.from_time || t.departureTime || '',
          to_code: t.to_stn_code || t.to || to,
          to_name: t.to_stn_name || t.toName || to,
          to_time: t.to_time || t.arrivalTime || '',
          travel_time: t.travel_time || t.duration || '',
          running_days: t.running_days || t.days || '1111111',
          train_type: t.train_type || t.type || 'EXPRESS',
          classes: t.classes || ''
        }));

        return res.status(200).json({
          status: 'OK',
          action: 'search',
          from,
          to,
          total: trains.length,
          data: trains
        });
      }
      return res.status(404).json({
        error: searchRes?.error || `No trains found operating between ${from} and ${to}.`
      });
    } catch (err) {
      return res.status(500).json({ error: `Search failed: ${err.message}` });
    }
  }

  // ── ROUTE 3: Train Info & Timetable ───────────────────────────────────────
  if (action === 'trainInfo') {
    const train = typeof req.query.train === 'string' ? req.query.train.trim() : '';
    if (!/^\d{4,5}$/.test(train)) {
      return res.status(400).json({ error: 'Please enter a valid train number.' });
    }

    try {
      const infoRes = await getTrainInfo(train);
      if (infoRes && infoRes.success && infoRes.data) {
        const tInfo = infoRes.data.trainInfo || {};
        const route = Array.isArray(infoRes.data.route) ? infoRes.data.route : [];
        return res.status(200).json({
          status: 'OK',
          action: 'trainInfo',
          data: {
            train_no: tInfo.train_no || train,
            train_name: tInfo.train_name || '',
            from_code: tInfo.from_stn_code || '',
            from_name: tInfo.from_stn_name || '',
            to_code: tInfo.to_stn_code || '',
            to_name: tInfo.to_stn_name || '',
            departure_time: tInfo.from_time || '',
            arrival_time: tInfo.to_time || '',
            travel_time: tInfo.travel_time || '',
            running_days: tInfo.running_days || '',
            train_type: tInfo.type || '',
            route: route.map(r => ({
              stn_code: r.stnCode || '',
              stn_name: r.stnName || '',
              arr_time: r.arrTime || '',
              dep_time: r.depTime || '',
              halt_mins: r.halt || '',
              distance: r.distance || '',
              day: r.day || 1
            }))
          }
        });
      }
      return res.status(404).json({ error: infoRes?.error || `Train #${train} not found.` });
    } catch (err) {
      return res.status(500).json({ error: `Failed to fetch train timetable: ${err.message}` });
    }
  }

  // ── ROUTE 4: Live Trains at Station ───────────────────────────────────────
  if (action === 'station') {
    const code = typeof req.query.code === 'string' ? req.query.code.trim().toUpperCase() : '';
    const hrs = parseInt(req.query.hrs) || 2;
    if (!code) {
      return res.status(400).json({ error: 'Please provide a valid station code (e.g. NDLS, CSMT).' });
    }

    try {
      const stnRes = await liveAtStation(code, hrs);
      if (stnRes && stnRes.success && stnRes.data) {
        const d = stnRes.data;
        const trains = Array.isArray(d.trains) ? d.trains : [];
        return res.status(200).json({
          status: 'OK',
          action: 'station',
          station_code: code,
          summary: d.summary || `${trains.length} trains arriving/departing`,
          total: d.totalTrains || trains.length,
          data: trains.map(t => ({
            train_no: t.trainNo || '',
            train_name: t.trainName || '',
            source: t.source || '',
            source_name: t.sourceName || '',
            dest: t.dest || '',
            dest_name: t.destName || '',
            expected_arr: t.expectedArr || t.schArr || '',
            expected_dep: t.expectedDep || t.schDep || '',
            delay_arr: t.delayArr || 'On Time',
            delay_dep: t.delayDep || 'On Time',
            platform: t.platform || '-'
          }))
        });
      }
      return res.status(404).json({ error: stnRes?.error || `No live trains found for station ${code}.` });
    } catch (err) {
      return res.status(500).json({ error: `Failed to fetch station status: ${err.message}` });
    }
  }

  // ── DEFAULT ROUTE: PNR Status & Confirmation Prediction ───────────────────
  const pnr = typeof req.query.pnr === 'string' ? req.query.pnr.trim() : '';
  if (!/^\d{10}$/.test(pnr)) {
    return res.status(400).json({ error: 'Please enter a valid 10-digit Indian Railways PNR number.' });
  }

  let lastError = null;

  // Primary: RailKit SDK
  if (RAILKIT_API_KEY) {
    try {
      const rkRes = await checkPNRStatus(pnr);
      if (rkRes && rkRes.success && rkRes.data) {
        return res.status(200).json({
          status: 'OK',
          pnr,
          provider: 'railkit',
          data: normalizeRailKit(rkRes.data, pnr),
          insights: generateWaitlistInsights(rkRes.data)
        });
      }
      if (rkRes && (rkRes.error || rkRes.message)) {
        lastError = rkRes.error || rkRes.message;
      }
    } catch (err) {
      console.warn('RailKit failed, fallback to RapidAPI:', err.message);
      lastError = err.message;
    }
  }

  // Secondary: RapidAPI IRCTC
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
            data: normalizeRapidAPI(rapidJson.data, pnr),
            insights: generateWaitlistInsights(rapidJson.data)
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

  const message = lastError || 'PNR details not found. The ticket may have expired or was cancelled.';
  return res.status(404).json({
    status: 'ERROR',
    error: message
  });
}

// ── Historical Waitlist Insights Generator ──────────────────────────────────
function generateWaitlistInsights(data) {
  return {
    wl_types_benchmark: [
      { type: 'GNWL', name: 'General Waitlist', clearance_rate: 86, desc: 'Highest priority when charts prepare' },
      { type: 'RAC', name: 'Reservation Against Cancellation', clearance_rate: 96, desc: 'Guaranteed boarding & seat allotment' },
      { type: 'RLWL', name: 'Remote Location Waitlist', clearance_rate: 60, desc: 'Allotted for intermediate cities' },
      { type: 'PQWL', name: 'Pooled Quota Waitlist', clearance_rate: 48, desc: 'Pooled across intermediate halts' },
      { type: 'TQWL', name: 'Tatkal Waitlist', clearance_rate: 32, desc: 'Clears only on Tatkal cancellations' }
    ],
    class_benchmarks: [
      { class: 'SL', name: 'Sleeper', avg_clearance: '20 - 35 seats', speed: 'Very High' },
      { class: '3A', name: 'AC 3 Tier', avg_clearance: '12 - 22 seats', speed: 'High' },
      { class: 'CC', name: 'Chair Car', avg_clearance: '10 - 18 seats', speed: 'Moderate' },
      { class: '2A', name: 'AC 2 Tier', avg_clearance: '4 - 8 seats', speed: 'Low' },
      { class: '1A', name: 'First AC', avg_clearance: '1 - 3 seats', speed: 'Very Low' }
    ],
    charting_rules: [
      { timing: '4 Hours Before Departure', event: 'First Chart Prepared — majority of RAC/WL promotions happen' },
      { timing: '30 Mins Before Departure', event: 'Second/Final Chart Prepared — last-minute cancellation allocations' },
      { timing: 'Post Chart Preparation', event: 'Fully waitlisted e-tickets auto-cancel and refund to original payment method' }
    ]
  };
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
    passengers
  };
}
