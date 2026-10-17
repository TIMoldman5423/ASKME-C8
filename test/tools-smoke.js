const T = require('../tools'); const { pool } = require('../db');
(async () => {
  const show = async (n, a) => console.log('\n#', n, JSON.stringify(a), '\n', JSON.stringify(await T.run(n, a)).slice(0, 700));
  await show('find_store', { text: 'hawthorn' });
  await show('find_store', { text: 'Toowoomba noodle box' });
  const f = (await T.run('find_store', { text: 'hawthorn nbx' })).matches[0];
  await show('store_summary', { store_id: f.id });
  await show('rank_stores', { brand: 'Noodle Box', limit: 3 });
  await show('group_totals', { group_by: 'brand' });
  await show('network_events', { event_type: 'Closure', limit: 3 });
  await show('data_status', {});
  await pool.end();
})();
