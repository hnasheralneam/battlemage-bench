// Rendered in place of a value that was never measured. Writing the absence
// out in words — rather than leaving a blank or a dash — keeps a missing
// measurement from reading as a zero or as an oversight. Pair it with
// missingClass() so it renders muted rather than looking like data.
const NOT_MEASURED = 'not measured';

function isMissing(value) {
  return value === null || value === undefined || value === '';
}

function num(value, decimals = 1) {
  if (isMissing(value)) return NOT_MEASURED;
  return Number(value).toFixed(decimals);
}

function int(value) {
  if (isMissing(value)) return NOT_MEASURED;
  return Number(value).toLocaleString('en-US');
}

function text(value) {
  return isMissing(value) ? NOT_MEASURED : value;
}

// A value with its unit attached. Templates can't append the unit themselves
// any more — "<%= fmt.int(x) %> MB" would render "not measured MB" when x is
// null. Pass `decimals` for a fixed-point number, omit it for an integer.
function unit(value, suffix, decimals) {
  if (isMissing(value)) return NOT_MEASURED;
  return `${decimals === undefined ? int(value) : num(value, decimals)} ${suffix}`;
}

// SQLite's datetime('now') stores 'YYYY-MM-DD HH:MM:SS' in UTC. The date half
// is all any page shows, and slicing avoids re-parsing it into a local-time
// Date that could land on the wrong day.
function date(value) {
  return isMissing(value) ? NOT_MEASURED : String(value).slice(0, 10);
}

// Class fragment for a cell whose value is absent, so the placeholder renders
// as muted prose instead of looking like data. Carries its own leading space
// so it appends cleanly to an existing class:
//   <td class="num<%= fmt.missingClass(r.vram_used_mb) %>">
// Kept separate from the formatters so those keep returning plain text and
// stay safe under EJS's auto-escaping <%= %>.
function missingClass(value) {
  return isMissing(value) ? ' not-measured' : '';
}

// One result as a self-contained Markdown table, for pasting into a forum
// thread or issue. Self-contained because a bare row without its header is
// unreadable wherever it lands. Pipes inside a value are escaped and newlines
// flattened, so a stray character can't break the table. The source URL is
// appended client-side (public/js/copy-row.js) — behind a reverse proxy the
// server doesn't reliably know its own public origin.
const MARKDOWN_COLUMNS = [
  ['Card', (r) => r.card],
  ['Backend', (r) => r.backend],
  ['Runtime', (r) => r.runtime],
  ['Model', (r) => r.model_name],
  ['Quant', (r) => r.quantization],
  ['Concurrency', (r) => r.concurrency],
  ['Context', (r) => int(r.context_length)],
  ['Prefill', (r) => int(r.prompt_tokens)],
  ['Gen tok/s', (r) => num(r.generation_tok_s)],
  ['Prompt eval tok/s', (r) => num(r.prompt_eval_tok_s)],
  ['tok/s per W', (r) => num(r.tok_s_per_watt, 2)],
  ['VRAM', (r) => unit(r.vram_used_mb, 'MB')],
  ['Stability', (r) => (r.crashed ? 'crashed' : 'stable')],
];

function markdownCell(value) {
  return String(value === null || value === undefined ? NOT_MEASURED : value)
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

function markdownRow(r) {
  const header = MARKDOWN_COLUMNS.map(([label]) => markdownCell(label));
  const cells = MARKDOWN_COLUMNS.map(([, read]) => markdownCell(read(r)));
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    `| ${cells.join(' | ')} |`,
  ].join('\n');
}

// JSON.stringify()'d data destined for an HTML attribute (e.g.
// data-chart="...") still needs HTML-escaping — JSON's own quoting rules
// don't protect against breaking out of an HTML attribute if a string field
// contains a literal '"', "'", "<", or "&". This does both steps in one
// call so call sites can't forget the second one.
function chartAttr(data) {
  return JSON.stringify(data)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  NOT_MEASURED,
  isMissing,
  num,
  int,
  text,
  unit,
  date,
  missingClass,
  markdownRow,
  chartAttr,
};
