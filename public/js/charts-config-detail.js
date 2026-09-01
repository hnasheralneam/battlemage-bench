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

  // Both line charts have the same shape — a numeric x-axis, one series per
  // value of a third column — so they share a builder rather than repeating
  // the whole Chart config twice. Rows missing either axis value are dropped:
  // prompt_tokens is null on runs submitted before the prefill axis existed,
  // and prompt_eval_tok_s is null whenever a submitter didn't measure it.
  function lineChart(canvasId, opts) {
    const rows = (readChartData(canvasId) || []).filter(
      (r) =>
        typeof r[opts.xKey] === 'number' &&
        typeof r[opts.yKey] === 'number' &&
        r[opts.seriesKey] !== null &&
        r[opts.seriesKey] !== undefined
    );
    if (rows.length === 0) return;

    const xValues = [...new Set(rows.map((r) => r[opts.xKey]))].sort((a, b) => a - b);

    const bySeries = new Map();
    rows.forEach((r) => {
      const key = r[opts.seriesKey];
      if (!bySeries.has(key)) bySeries.set(key, new Map());
      bySeries.get(key).set(r[opts.xKey], r[opts.yKey]);
    });

    const datasets = [...bySeries.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([key, byX], i) => ({
        label: opts.seriesLabel(key),
        data: xValues.map((x) => (byX.has(x) ? byX.get(x) : null)),
        borderColor: palette[i % palette.length],
        backgroundColor: palette[i % palette.length],
        borderWidth: 2,
        pointRadius: 2.5,
        spanGaps: true,
        tension: 0.15,
      }));

    new Chart(document.getElementById(canvasId), {
      type: 'line',
      data: { labels: xValues, datasets },
      options: {
        responsive: true,
        plugins: {
          legend: {
            labels: { boxWidth: 10, boxHeight: 10 },
            // Long series-label stacks take needed height on narrow
            // viewports — drop below the chart instead.
            position: window.innerWidth < 700 ? 'bottom' : 'top',
          },
        },
        scales: {
          x: {
            title: { display: window.innerWidth >= 700, text: opts.xTitle },
            grid: { display: false },
            border: { color: grid },
          },
          y: {
            beginAtZero: true,
            title: { display: true, text: opts.yTitle },
            grid: { color: grid },
            border: { display: false },
          },
        },
      },
    });
  }

  // Generation throughput against the server's context budget, one series
  // per concurrency level.
  lineChart('context-chart', {
    xKey: 'context_length',
    yKey: 'generation_tok_s',
    seriesKey: 'concurrency',
    seriesLabel: (n) => 'Concurrency ' + n,
    xTitle: 'Context length (tokens)',
    yTitle: 'Generation tok/s',
  });

  // Prefill throughput against prompt length — prefill is the axis that
  // actually moves prompt_eval_tok_s — split by context level, since a
  // fixed context budget is what limits how long a prompt can get.
  lineChart('prefill-chart', {
    xKey: 'prompt_tokens',
    yKey: 'prompt_eval_tok_s',
    seriesKey: 'context_length',
    seriesLabel: (n) => 'Context ' + Number(n).toLocaleString('en-US'),
    xTitle: 'Prefill length (prompt tokens)',
    yTitle: 'Prompt eval tok/s',
  });

  // Bar chart: generation tok/s by model AND quantization, averaged across the
  // runs sharing a bar. Model has to be part of the key — averaging a 27B
  // dense model and a 35B MoE into one "Q4_K_M" bar describes neither.
  const quantData = readChartData('quant-chart');
  if (Array.isArray(quantData) && quantData.length > 0) {
    const byQuant = new Map();
    quantData.forEach((row) => {
      const key = row.model_name + ' · ' + row.quantization;
      if (!byQuant.has(key)) byQuant.set(key, []);
      byQuant.get(key).push(row.generation_tok_s);
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
