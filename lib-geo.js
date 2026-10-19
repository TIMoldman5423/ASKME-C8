// Server-side geocoding with the Google Geocoding API. Results are stored on the store row, so Google is called once per store.
const KEY = () => process.env.GOOGLE_GEOCODE_KEY || process.env.GOOGLE_MAPS_API_KEY;

async function lookup(query) {
  if (process.env.GEOCODE_MOCK) return { lat: -37.8 + (query.length % 10) / 100, lng: 144.9, partial: false };   // test double
  const u = 'https://maps.googleapis.com/maps/api/geocode/json?region=au&components=country:AU&address=' + encodeURIComponent(query) + '&key=' + KEY();
  const r = await fetch(u); const j = await r.json();
  if (j.status !== 'OK' || !j.results.length) return { error: j.status + (j.error_message ? ': ' + j.error_message : '') };
  const g = j.results[0]; return { lat: g.geometry.location.lat, lng: g.geometry.location.lng, partial: !!g.partial_match };
}
const queryFor = s => s.address ? { q: s.address.replace(/\s+/g, ' '), src: 'address' } : { q: `${s.name.replace(/^OTR_/, 'OTR ').replace(/\b(NBX|AB|PS|HUX|SS)\b/g, '').trim()} ${s.brand.replace(' - OTR', '')} restaurant${s.state ? ' ' + s.state : ''}, Australia`, src: 'name' };

async function geocodeMissing(c, limit = 200) {
  if (!KEY() && !process.env.GEOCODE_MOCK) throw new Error('No Google key set (GOOGLE_GEOCODE_KEY or GOOGLE_MAPS_API_KEY)');
  const rows = (await c.query(`SELECT id,name,brand,state,address FROM stores WHERE lat IS NULL AND active ORDER BY (address IS NULL), id LIMIT $1`, [limit])).rows;
  let ok = 0; const failed = [];
  for (const s of rows) {
    const { q, src } = queryFor(s); const g = await lookup(q);
    if (g.error) { failed.push(`${s.name}: ${g.error}`); continue; }
    await c.query('UPDATE stores SET lat=$2,lng=$3,geo_source=$4 WHERE id=$1', [s.id, g.lat, g.lng, g.partial && src === 'address' ? 'name' : src]); ok++;
  }
  const left = Number((await c.query('SELECT count(*) n FROM stores WHERE lat IS NULL AND active')).rows[0].n);
  const using = process.env.GEOCODE_MOCK ? 'test' : process.env.GOOGLE_GEOCODE_KEY ? 'GOOGLE_GEOCODE_KEY' : 'GOOGLE_MAPS_API_KEY (GOOGLE_GEOCODE_KEY is not set in the running app)';
  return { found: ok, failed, remaining: left, using };
}
module.exports = { geocodeMissing, queryFor };
