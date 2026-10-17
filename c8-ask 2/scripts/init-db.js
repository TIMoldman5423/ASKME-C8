const fs = require('fs'), path = require('path');
const { pool } = require('../db');
(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  console.log('schema ready');
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
