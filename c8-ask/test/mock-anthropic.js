// Test double for the Anthropic client: scripted tool loop (find_store -> store_summary -> text).
module.exports = { messages: { async create({ messages }) {
  const last = messages[messages.length - 1];
  const results = Array.isArray(last.content) ? last.content.filter(b => b.type === 'tool_result').map(b => JSON.parse(b.content)) : [];
  if (!results.length) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'find_store', input: { text: 'hawthorn nbx' } }] };
  if (results[0].matches) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'store_summary', input: { store_id: results[0].matches[0].id } }] };
  const s = results[0];
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: `${s.store} did $${s.latest.sales.toLocaleString()} in the week ending ${s.latest.week_ending}.` }] };
} } };
