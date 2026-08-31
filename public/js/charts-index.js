(function () {
  const canvas = document.getElementById('best-runs-chart');
  if (!canvas || typeof Chart === 'undefined') return;

  let data;
  try {
    data = JSON.parse(canvas.dataset.chart);
  } catch (err) {
    return;
  }
  if (!Array.isArray(data) || data.length === 0) return;

  const css = getComputedStyle(document.documentElement);
  const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const accent = token('--accent', '#0b5cff');
  const grid = token('--border', '#dbe3ef');
  Chart.defaults.color = token('--text-muted', '#4d5c75');
  Chart.defaults.font.family = token('--font-mono', 'monospace');
  Chart.defaults.font.size = 11;

  new Chart(canvas, {
    type: 'bar',
    data: {
      labels: data.map((d) => d.label),
      datasets: [
        {
          label: 'Generation tok/s',
          data: data.map((d) => d.generation_tok_s),
          backgroundColor: accent,
          borderRadius: 2,
          maxBarThickness: 42,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          grid: { display: false },
          border: { color: grid },
          ticks: {
            // Long "card / backend / runtime" labels become an illegible
            // tangle on narrow viewports — hide them below ~700px.
            callback() { return window.innerWidth < 700 ? '' : this.getLabelForValue(this.value); },
          },
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: 'tok/s' },
          grid: { color: grid },
          border: { display: false },
        },
      },
    },
  });
})();
