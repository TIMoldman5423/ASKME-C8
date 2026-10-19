const { Pool } = require('pg');
const ssl = process.env.DATABASE_SSL === 'false' || /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '') ? false : { rejectUnauthorized: false };
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 5 });
module.exports = { pool, q: (text, params) => pool.query(text, params) };
