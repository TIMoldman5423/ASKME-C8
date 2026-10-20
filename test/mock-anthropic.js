// Test double for the Anthropic client: scripted tool loop (find_store -> store_summary -> text).
const mock = { lastPrompt: '', messages: { async create({ messages }) {
  const last = messages[messages.length - 1]; if (typeof last.content === 'string') mock.lastPrompt = last.content;
  if (typeof last.content === 'string') mock.firstPrompt = last.content;
  const results = Array.isArray(last.content) ? last.content.filter(b => b.type === 'tool_result').map(b => JSON.parse(b.content)) : [];
  if (!results.length) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'find_store', input: { text: 'hawthorn nbx' } }] };
  if (results[0].matches) mock.lastId = results[0].matches[0].id;
  if (results[0].stores_shown !== undefined) return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'That store is in the area shown on the map.' }] };
  if (results[0].store && /where is/i.test(mock.firstPrompt || '')) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't3', name: 'show_on_map', input: { store_ids: [mock.lastId] } }] };
  if (results[0].matches) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'store_summary', input: { store_id: results[0].matches[0].id } }] };
  const s = results[0];
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: `${s.store} did $${s.latest.sales.toLocaleString()} in the week ending ${s.latest.week_ending}.` }] };
} } };
module.exports = mock;
