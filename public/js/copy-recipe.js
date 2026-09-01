(function () {
  const btn = document.getElementById('copy-recipe-btn');
  const pre = document.getElementById('recipe-source');
  if (!btn || !pre) return;

  btn.addEventListener('click', async function () {
    const originalLabel = btn.textContent;
    try {
      await navigator.clipboard.writeText(pre.textContent);
      btn.textContent = 'Copied!';
    } catch (err) {
      // Clipboard API can fail (permissions, insecure context) — fall back to
      // selecting the text so it can still be copied by hand.
      const range = document.createRange();
      range.selectNodeContents(pre);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      btn.textContent = 'Select-copy manually';
    }
    setTimeout(function () {
      btn.textContent = originalLabel;
    }, 2000);
  });
})();
