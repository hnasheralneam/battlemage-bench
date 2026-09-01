(function () {
  // One delegated listener rather than one per row: a results table can run
  // to hundreds of rows, and this keeps working for any table that grows a
  // copy button later.
  document.addEventListener('click', function (event) {
    const btn = event.target.closest('[data-copy]');
    if (!btn) return;

    // The server can't reliably know its own public origin behind a reverse
    // proxy, so the source link is stitched on here where it's known for sure.
    const text = btn.getAttribute('data-copy') + '\n\nSource: ' + location.origin + location.pathname;

    function flash(label, symbol) {
      const original = btn.textContent;
      const originalLabel = btn.getAttribute('aria-label');
      btn.textContent = symbol;
      btn.setAttribute('aria-label', label);
      setTimeout(function () {
        btn.textContent = original;
        btn.setAttribute('aria-label', originalLabel);
      }, 1600);
    }

    // Clipboard API needs a secure context and permission; on failure the
    // row is still recoverable from the page, so this only reports.
    navigator.clipboard.writeText(text).then(
      function () { flash('Copied to clipboard', '✓'); },
      function () { flash('Copy failed — select the row manually', '✕'); }
    );
  });
})();
