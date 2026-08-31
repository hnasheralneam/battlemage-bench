(function () {
  const btn = document.getElementById('copy-prompt-btn');
  const pre = document.getElementById('agent-prompt');
  if (!btn || !pre) return;

  btn.addEventListener('click', async function () {
    const text = pre.textContent;
    const originalLabel = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied!';
    } catch (err) {
      // Clipboard API can fail (permissions, insecure context) — fall back
      // to a manual select so the user can still copy.
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
