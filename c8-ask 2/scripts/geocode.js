const { pool } = require('../db'); const G = require('../lib-geo');
(async () => { const c = await pool.connect(); try { console.log(await G.geocodeMissing(c, 1000)); } finally { c.release(); await pool.end(); } })().catch(e => { console.error(e.message); process.exit(1); });
