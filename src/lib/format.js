function num(value, decimals = 1) {
  if (value === null || value === undefined) return '—';
  return Number(value).toFixed(decimals);
}

function int(value) {
  if (value === null || value === undefined) return '—';
  return Number(value).toLocaleString('en-US');
}

function text(value) {
  return value === null || value === undefined || value === '' ? '—' : value;
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

module.exports = { num, int, text, chartAttr };
