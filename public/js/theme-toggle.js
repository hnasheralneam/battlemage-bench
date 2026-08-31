(function () {
  const STORAGE_KEY = 'bmb-theme';
  const btn = document.getElementById('theme-toggle-btn');
  if (!btn) return;

  const mql = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');

  function getStored() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return null;
    }
  }

  function systemPrefersDark() {
    return !!(mql && mql.matches);
  }

  function currentTheme() {
    const explicit = document.documentElement.getAttribute('data-theme');
    if (explicit === 'light' || explicit === 'dark') return explicit;
    return systemPrefersDark() ? 'dark' : 'light';
  }

  function applyButtonState(theme) {
    const isDark = theme === 'dark';
    btn.setAttribute('aria-pressed', String(isDark));
    btn.setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (e) {}
    applyButtonState(theme);
  }

  btn.addEventListener('click', function () {
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  });

  // Keep the button's aria state in sync if the OS theme changes while the
  // page is open and the visitor hasn't made an explicit choice yet.
  if (mql && mql.addEventListener) {
    mql.addEventListener('change', function () {
      if (!getStored()) applyButtonState(currentTheme());
    });
  }

  applyButtonState(currentTheme());
})();
