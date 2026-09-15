// Slide-out side panel for per-row run details (full command, driver/SDK
// versions, raw log). Replaces the old inline <details> expansion in the
// results/config tables, which pushed every row below it around when
// opened — unworkable once a table has more than a handful of rows,
// especially with several rows open at once.
//
// Each trigger button's <td> keeps the row's detail markup in a normally
// hidden sibling (.row-details-source); clicking the button clones that
// markup into one shared panel instead of expanding in place.
(function () {
  var panel = document.getElementById('details-panel');
  var overlay = document.getElementById('details-overlay');
  var body = document.getElementById('details-panel-body');
  var closeBtn = document.getElementById('details-panel-close');
  if (!panel || !overlay || !body || !closeBtn) return;

  var lastTrigger = null;

  function open(trigger) {
    var source = trigger.nextElementSibling;
    if (!source) return;
    body.innerHTML = source.innerHTML;
    if (lastTrigger) lastTrigger.setAttribute('aria-expanded', 'false');
    lastTrigger = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    panel.classList.add('is-open');
    overlay.classList.add('is-open');
    closeBtn.focus();
  }

  function close() {
    panel.classList.remove('is-open');
    overlay.classList.remove('is-open');
    if (lastTrigger) {
      lastTrigger.setAttribute('aria-expanded', 'false');
      lastTrigger.focus();
      lastTrigger = null;
    }
  }

  document.addEventListener('click', function (e) {
    var trigger = e.target.closest('.row-details-trigger');
    if (trigger) {
      open(trigger);
      return;
    }
    if (e.target === closeBtn || e.target === overlay) close();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && panel.classList.contains('is-open')) close();
  });
})();
