const fs = require('fs');
const path = require('path');

// The recipes are the launch scripts this site recommends, and the same files
// the benchmark runner sources — so a published number and the script a
// reader copies can never drift apart. They are read from disk here rather
// than duplicated into a JS object for the same reason.
const RECIPES_DIR = path.join(__dirname, '..', '..', 'recipes');

// The declaration block every recipe carries near the top. Parsed rather than
// executed: these files are bash, and rendering a page must never run one.
const META_KEYS = {
  RECIPE_NAME: 'name',
  RECIPE_RUNTIME: 'runtime',
  RECIPE_BACKEND: 'backend',
  RECIPE_PROFILE: 'profile',
  RECIPE_KV_CACHE_TYPE: 'kvCacheType',
};

// Ordered worst-context-to-best so the three always render in a stable,
// meaningful order rather than alphabetically (balanced, context,
// performance), which reads as arbitrary.
const PROFILE_ORDER = ['performance', 'balanced', 'context'];

function parseMeta(source) {
  const meta = {};
  for (const line of source.split('\n')) {
    const match = line.match(/^([A-Z_]+)="(.*)"$/);
    if (!match) continue;
    const key = META_KEYS[match[1]];
    if (key) meta[key] = match[2];
  }
  return meta;
}

// The leading comment block, minus the shebang and minus the boilerplate the
// page renders for itself (the results link, the usage/override notes) — what
// is left is the part that says what the recipe is for and what it costs.
function parseDescription(source) {
  const lines = [];
  for (const line of source.split('\n').slice(1)) {
    if (!line.startsWith('#')) break;
    const text = line.replace(/^#\s?/, '');
    if (/^Usage:/.test(text) || /^Measured results/.test(text)) break;
    lines.push(text);
  }
  return lines.join('\n').trim();
}

function load() {
  let files;
  try {
    files = fs.readdirSync(RECIPES_DIR).filter((f) => f.endsWith('.sh'));
  } catch (err) {
    // A deployment without the recipes directory should render an empty
    // recipes page, not 500 on every request.
    return [];
  }

  const recipes = files
    .map((file) => {
      const source = fs.readFileSync(path.join(RECIPES_DIR, file), 'utf8');
      const meta = parseMeta(source);
      if (!meta.name) return null; // not a recipe (lib/ helpers, strays)
      return {
        ...meta,
        file,
        source,
        description: parseDescription(source),
      };
    })
    .filter(Boolean);

  recipes.sort((a, b) => {
    if (a.runtime !== b.runtime) return a.runtime.localeCompare(b.runtime);
    if (a.backend !== b.backend) return a.backend.localeCompare(b.backend);
    return PROFILE_ORDER.indexOf(a.profile) - PROFILE_ORDER.indexOf(b.profile);
  });
  return recipes;
}

// Read once at boot. The files ship with the app and don't change under a
// running process; re-reading per request would just be I/O for nothing.
const RECIPES = load();
const BY_NAME = new Map(RECIPES.map((r) => [r.name, r]));

function all() {
  return RECIPES;
}

// Lookup by name, which doubles as the whitelist for the :name route — a
// path segment can only ever resolve to a file that was on disk at boot, so
// there is no way to reach the filesystem through it.
function byName(name) {
  return BY_NAME.get(name) || null;
}

module.exports = { all, byName, PROFILE_ORDER };
