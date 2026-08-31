(function () {
  const form = document.getElementById('submit-form');
  const fillBtn = document.getElementById('fill-from-json-btn');
  const jsonBox = document.getElementById('agent-json');
  const status = document.getElementById('fill-from-json-status');

  function setStatus(message, isError) {
    if (!status) return;
    status.textContent = message;
    status.className = 'fill-status' + (isError ? ' fill-status-error' : ' fill-status-ok');
  }

  if (fillBtn && jsonBox && form) {
    fillBtn.addEventListener('click', function () {
      let data;
      try {
        data = JSON.parse(jsonBox.value);
      } catch (err) {
        setStatus('That doesn’t look like valid JSON — check for stray text before/after the { }.', true);
        return;
      }
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        setStatus('Expected a single JSON object.', true);
        return;
      }

      let filled = 0;
      Object.keys(data).forEach(function (key) {
        const el = form.elements.namedItem(key);
        if (!el) return; // unknown field — ignore rather than error
        const value = data[key];

        if (el.type === 'checkbox') {
          el.checked = value === true || value === 'true';
        } else {
          el.value = value === null || value === undefined ? '' : value;
        }
        filled += 1;
      });

      setStatus('Filled ' + filled + ' field' + (filled === 1 ? '' : 's') + ' from the pasted JSON. Review before submitting.', false);
    });
  }

  // The form uses novalidate so we control the validation UI ourselves, but
  // still lean on the browser's built-in constraint validation (required,
  // type=number, min) rather than reimplementing it.
  if (form) {
    form.addEventListener('submit', function (event) {
      if (!form.checkValidity()) {
        event.preventDefault();
        form.reportValidity();
      }
    });
  }
})();
