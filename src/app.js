const path = require('path');
const express = require('express');
const session = require('express-session');
const config = require('./config');
require('./db'); // ensures schema/migrations run on boot

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
if (config.isProduction) app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Lightweight query-string flash (no session needed until Phase D wires up
// express-session for /admin). Not for sensitive data — just UX messages
// after a redirect, e.g. /submit/thanks.
app.use((req, res, next) => {
  const { flash, flashType } = req.query;
  res.locals.flash = flash ? { message: flash, type: flashType || 'info' } : null;
  next();
});
// Make formatting helpers available in every EJS template without an
// explicit require in each route.
const fmt = require('./lib/format');
app.use((req, res, next) => {
  res.locals.fmt = fmt;
  next();
});
// Lets the nav partial highlight the current section without every route
// having to remember to pass it in.
app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  next();
});

app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: 8 * 60 * 60 * 1000, // 8h
    },
    // In-memory store: fine for a single-admin hobby site — a restart just
    // means logging back in. Swap for connect-sqlite3 if that gets old.
  })
);

app.use('/', require('./routes/index'));
app.use('/results', require('./routes/results'));
app.use('/configs', require('./routes/configs'));
app.use('/methodology', require('./routes/methodology'));
app.use('/submit', require('./routes/submit'));
app.use('/admin', require('./routes/admin'));

// Catch-all 404 — anything unmatched gets the styled not-found page.
app.use((req, res) => {
  res.status(404).render('404', { title: 'Not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Internal server error');
});

module.exports = app;
