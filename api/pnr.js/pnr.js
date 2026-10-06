export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET for a PNR lookup.' });
  const pnr = typeof req.query.pnr === 'string' ? req.query.pnr : '';
  if (!/^\d{10}$/.test(pnr)) return res.status(400).json({ error: 'Enter a valid 10-digit PNR.' });
  try {
    const upstream = await fetch('http://pnrapi.dfth.in/pnr/' + pnr, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
      cache: 'no-store'
    });
    if (!upstream.ok) return res.status(502).json({ error: 'The PNR provider is temporarily unavailable.' });
    const result = await upstream.json();
    if (result.status !== 'OK' || !result.data) return res.status(502).json({ error: 'The PNR provider could not return a live status. Try again later.' });
    return res.status(200).json(result);
  } catch {
    return res.status(502).json({ error: 'Could not reach the PNR provider. Its archived service may be offline.' });
  }
}
