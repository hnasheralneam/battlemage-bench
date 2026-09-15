(function () {
  var container = document.getElementById('bg-ambient');
  if (!container) return;

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var palette = ['var(--accent)', 'var(--blob-2)', 'var(--blob-3)'];
  var resizeTimer;
  var layers = [];
  var ticking = false;

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function pageHeight() {
    var doc = document.documentElement;
    return Math.max(
      document.body.scrollHeight,
      document.body.offsetHeight,
      doc.scrollHeight,
      doc.offsetHeight,
      doc.clientHeight
    );
  }

  // Resizes the container to the current document height. Blob positions
  // are stored in percent, so they reflow proportionally when this changes.
  function resizeContainer() {
    container.style.height = pageHeight() + 'px';
  }

  // Scatters a mix of soft filled blobs and faint outline rings down the
  // full length of the page, so scrolling keeps revealing new ones instead
  // of the same handful stuck in the viewport.
  function buildBlobs() {
    resizeContainer();
    var height = pageHeight();
    var count = Math.max(6, Math.min(16, Math.round(height / 600)));
    var frag = document.createDocumentFragment();
    layers = [];

    for (var i = 0; i < count; i++) {
      // The layer carries position/size; the blob inside it carries the
      // color/shape and the ambient drift animation. Splitting them means
      // the scroll-driven parallax transform (on the layer) never fights
      // with the drift keyframes' transform (on the blob).
      var layer = document.createElement('span');
      layer.className = 'blob-layer';

      var el = document.createElement('span');
      var outline = Math.random() < 0.5;
      el.className = 'blob ' + (outline ? 'blob-outline' : 'blob-filled');

      var size = outline ? rand(12, 22) : rand(18, 34);
      var top = ((i + 0.5) / count) * 100 + rand(-8, 8);
      top = Math.min(97, Math.max(1, top));
      var left = rand(-10, 88);
      var color = palette[Math.floor(Math.random() * palette.length)];

      layer.style.width = size + 'vmax';
      layer.style.height = size + 'vmax';
      layer.style.top = top + '%';
      layer.style.left = left + '%';

      if (outline) {
        el.style.borderColor = color;
      } else {
        el.style.background = color;
      }

      if (!reduceMotion) {
        el.style.setProperty('--dx', rand(-10, 10).toFixed(1) + 'vw');
        el.style.setProperty('--dy', rand(-8, 8).toFixed(1) + 'vh');
        el.style.setProperty('--s', rand(0.88, 1.18).toFixed(2));
        el.style.animationDuration = rand(40, 72).toFixed(0) + 's';
        el.style.animationDelay = '-' + rand(0, 40).toFixed(0) + 's';

        // Smaller outline rings read as "further back" and drift slower;
        // bigger filled blobs sit closer and move a bit more per scroll px.
        var depth = outline ? rand(0.16, 0.34) : rand(0.32, 0.58);
        layers.push({ el: layer, depth: depth });
      }

      layer.appendChild(el);
      frag.appendChild(layer);
    }

    container.innerHTML = '';
    container.appendChild(frag);
    updateParallax();
  }

  function updateParallax() {
    if (reduceMotion || !layers.length) return;
    var y = window.scrollY || window.pageYOffset || 0;
    for (var i = 0; i < layers.length; i++) {
      // Positive offset counteracts part of the scroll, so the blob (sat
      // behind the content, z-index -1) lags and reads as further away
      // instead of racing past the foreground.
      var offset = (y * layers[i].depth).toFixed(1);
      layers[i].el.style.transform = 'translate3d(0, ' + offset + 'px, 0)';
    }
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      updateParallax();
      ticking = false;
    });
  }

  function scheduleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeContainer, 200);
  }

  buildBlobs();

  // Fonts/images can still change document height after the initial layout.
  window.addEventListener('load', resizeContainer);
  window.addEventListener('resize', scheduleResize);

  if (!reduceMotion) {
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(scheduleResize).observe(document.body);
  }
})();
