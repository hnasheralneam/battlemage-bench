(function () {
  const form = document.getElementById('submit-form');
  const fillBtn = document.getElementById('fill-from-json-btn');
  const jsonBox = document.getElementById('agent-json');
  const status = document.getElementById('fill-from-json-status');
  const steps = Array.prototype.slice.call(document.querySelectorAll('.form-step'));
  const pathCards = Array.prototype.slice.call(document.querySelectorAll('.path-card'));

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // The site header is sticky and its nav wraps to two or three rows on narrow
  // screens, so scroll-margin-top has to track its real height or scrolled-to
  // steps end up hidden underneath it.
  const siteHeader = document.querySelector('.site-header');
  function measureHeader() {
    if (!siteHeader) return;
    document.documentElement.style.setProperty('--sticky-header-h', siteHeader.offsetHeight + 'px');
  }
  measureHeader();
  window.addEventListener('resize', measureHeader);

  function scrollTo(el) {
    if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  }

  function setStatus(message, isError) {
    if (!status) return;
    status.textContent = message;
    status.className = 'fill-status' + (isError ? ' fill-status-error' : ' fill-status-ok');
  }

  // ---- Path chooser -------------------------------------------------------
  // Both panels stay in the DOM; picking one just marks the card and scrolls.
  function selectPath(target) {
    pathCards.forEach(function (card) {
      const isActive = card.dataset.pathTarget === target;
      card.classList.toggle('is-active', isActive);
      card.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }

  pathCards.forEach(function (card) {
    card.addEventListener('click', function () {
      const target = card.dataset.pathTarget;
      selectPath(target);
      scrollTo(document.getElementById(target));
    });
  });

  // ---- Collapsible steps --------------------------------------------------
  // The markup renders every step open so the form still works without JS.
  // From here on it behaves as a single-open accordion.
  function controlsIn(step) {
    return Array.prototype.slice.call(step.querySelectorAll('input, select, textarea'));
  }

  function hasValue(step) {
    return controlsIn(step).some(function (el) {
      if (el.type === 'checkbox') return el.checked;
      return el.value !== '' && el.value !== null;
    });
  }

  function openOnly(step) {
    steps.forEach(function (s) {
      s.open = s === step;
    });
  }

  // Reports the first constraint violation in a step. Only ever called on an
  // open step — a control inside a closed <details> can't be focused, and
  // reportValidity() on an unfocusable control fails silently.
  function reportStep(step) {
    let firstInvalid = null;
    controlsIn(step).forEach(function (el) {
      const ok = el.checkValidity();
      const row = el.closest('.form-row');
      if (row) row.classList.toggle('has-error', !ok);
      if (!ok && !firstInvalid) firstInvalid = el;
    });
    if (firstInvalid) {
      firstInvalid.reportValidity();
      return false;
    }
    return true;
  }

  steps.forEach(function (step, index) {
    const next = step.querySelector('.step-next-btn');
    const back = step.querySelector('.step-back-btn');

    if (next) {
      next.addEventListener('click', function () {
        if (!reportStep(step)) return;
        step.dataset.complete = '';
        const following = steps[index + 1];
        if (following) {
          openOnly(following);
          scrollTo(following);
        } else {
          step.open = false;
        }
      });
    }

    if (back) {
      back.addEventListener('click', function () {
        const previous = steps[index - 1];
        if (!previous) return;
        openOnly(previous);
        scrollTo(previous);
      });
    }

    // Opening a step by clicking its summary closes the others, so the page
    // never grows back into the wall of fields this replaced.
    step.addEventListener('toggle', function () {
      if (!step.open) return;
      steps.forEach(function (s) {
        if (s !== step) s.open = false;
      });
    });
  });

  if (steps.length) {
    // A server-rendered 400 marks the offending rows; open the first step
    // holding one rather than the first step overall.
    const errored = steps.filter(function (s) {
      return s.querySelector('.has-error');
    });
    openOnly(errored[0] || steps[0]);
    if (errored[0]) {
      selectPath('manual-path');
      scrollTo(errored[0]);
    }
  }

  // ---- Fill from agent JSON ----------------------------------------------
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

      // Nothing is submitted sight-unseen: tick the sections the paste
      // touched, then hand the user back to the form to review them.
      steps.forEach(function (step) {
        if (hasValue(step)) step.dataset.complete = '';
        else delete step.dataset.complete;
      });
      if (steps.length) openOnly(steps[0]);
      selectPath('manual-path');
      scrollTo(document.getElementById('manual-path'));

      setStatus(
        'Filled ' + filled + ' field' + (filled === 1 ? '' : 's') +
          '. Step through the sections below and check each one before submitting.',
        false
      );
    });
  }

  // The form uses novalidate so we control the validation UI ourselves, but
  // still lean on the browser's built-in constraint validation (required,
  // type=number, min) rather than reimplementing it.
  if (form) {
    form.addEventListener('submit', function (event) {
      if (form.checkValidity()) return;
      event.preventDefault();

      // Find the offending control and open its step first — a closed
      // <details> hides it, and reportValidity() on an unfocusable control
      // would block the submit with no visible explanation.
      const invalid = Array.prototype.slice
        .call(form.querySelectorAll('input, select, textarea'))
        .find(function (el) {
          return !el.checkValidity();
        });
      if (!invalid) {
        form.reportValidity();
        return;
      }
      const step = invalid.closest('.form-step');
      if (step) {
        openOnly(step);
        scrollTo(step);
        reportStep(step);
      } else {
        invalid.reportValidity();
      }
    });
  }
})();
