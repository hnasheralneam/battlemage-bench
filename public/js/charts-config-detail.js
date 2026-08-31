(function () {
  if (typeof Chart === 'undefined') return;

  const css = getComputedStyle(document.documentElement);
  const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const palette = [
    token('--chart-1', '#0b5cff'),
    token('--chart-2', '#00a3d6'),
    token('--chart-3', '#5a8bff'),
    token('--chart-4', '#0448b8'),
    token('--chart-5', '#67d4f5'),
  ];
  const grid = token('--border', '#dbe3ef');
  Chart.defaults.color = token('--text-muted', '#4d5c75');
  Chart.defaults.font.family = token('--font-mono', 'monospace');
  Chart.defaults.font.size = 11;

  function readChartData(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    try {
      return JSON.parse(el.dataset.chart);
    } catch (err) {
      return null;
    }
  }

  // Line chart: generation tok/s vs. context length, one series per
  // concurrency level present in the data.
  const contextData = readChartData('context-chart');
  if (Array.isArray(contextData) && contextData.length > 0) {
    const byConcurrency = new Map();
    contextData.forEach((row) => {
      if (!byConcurrency.has(row.concurrency)) byConcurrency.set(row.concurrency, []);
      byConcurrency.get(row.concurrency).push(row);
    });

    const contextLengths = [...new Set(contextData.map((r) => r.context_length))].sort((a, b) => a - b);

    const datasets = [...byConcurrency.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([concurrency, rows], i) => {
        rows.sort((a, b) => a.context_length - b.context_length);
        const byContext = new Map(rows.map((r) => [r.context_length, r.generation_tok_s]));
        return {
          label: 'Concurrency ' + concurrency,
          data: contextLengths.map((cl) => (byContext.has(cl) ? byContext.get(cl) : null)),
          borderColor: palette[i % palette.length],
          backgroundColor: palette[i % palette.length],
          borderWidth: 2,
          pointRadius: 2.5,
          spanGaps: true,
          tension: 0.15,
        };
      });

    new Chart(document.getElementById('context-chart'), {
      type: 'line',
      data: { labels: contextLengths, datasets },
      options: {
        responsive: true,
        plugins: {
          legend: {
            labels: { boxWidth: 10, boxHeight: 10 },
            // Long "Concurrency N" legend stacks take needed height on
            // narrow viewports — drop below the chart instead.
            position: window.innerWidth < 700 ? 'bottom' : 'top',
          },
        },
        scales: {
          x: {
            title: { display: window.innerWidth >= 700, text: 'Context length (tokens)' },
            grid: { display: false },
            border: { color: grid },
          },
          y: {
            beginAtZero: true,
            title: { display: true, text: 'Generation tok/s' },
            grid: { color: grid },
            border: { display: false },
          },
        },
      },
    });
  }

  // Bar chart: generation tok/s by quantization (averaged if more than one
  // run shares the same quant).
  const quantData = readChartData('quant-chart');
  if (Array.isArray(quantData) && quantData.length > 0) {
    const byQuant = new Map();
    quantData.forEach((row) => {
      if (!byQuant.has(row.quantization)) byQuant.set(row.quantization, []);
      byQuant.get(row.quantization).push(row.generation_tok_s);
    });
    const labels = [...byQuant.keys()];
    const values = labels.map((q) => {
      const vals = byQuant.get(q);
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    });

    new Chart(document.getElementById('quant-chart'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{ label: 'Avg. generation tok/s', data: values, backgroundColor: palette[0], borderRadius: 2, maxBarThickness: 42 }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, border: { color: grid } },
          y: {
            beginAtZero: true,
            title: { display: true, text: 'tok/s' },
            grid: { color: grid },
            border: { display: false },
          },
        },
      },
    });
  }
})();
