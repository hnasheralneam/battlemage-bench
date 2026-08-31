const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const config = require('../config');
const requireAdmin = require('../middleware/requireAdmin');
const { getPending, getById, setStatus, updateSubmission } = require('../lib/queries');
const { CARDS, BACKENDS, RUNTIMES, TRISTATE } = require('../lib/constants');

// Simple in-memory brute-force friction: a single shared admin password is
// reachable from the public internet, so a few lines of per-IP lockout is
// worth it even without a full rate-limit library. Resets on server
// restart — acceptable for a hobby-scale single-admin site.
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const attempts = new Map(); // ip -> { count, lockedUntil }

function getAttempt(ip) {
  return attempts.get(ip) || { count: 0, lockedUntil: 0 };
}

function recordFailure(ip) {
  const a = getAttempt(ip);
  a.count += 1;
  if (a.count >= LOCKOUT_THRESHOLD) {
    a.lockedUntil = Date.now() + LOCKOUT_MS;
    a.count = 0;
  }
  attempts.set(ip, a);
}

function clearAttempts(ip) {
  attempts.delete(ip);
}

router.get('/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin');
  res.render('admin/login', { title: 'Admin login', error: null, next: req.query.next || '/admin' });
});

router.post('/login', (req, res) => {
  const ip = req.ip;
  const { lockedUntil } = getAttempt(ip);
  const next = req.body.next || '/admin';

  if (Date.now() < lockedUntil) {
    return res.status(429).render('admin/login', {
      title: 'Admin login',
      error: 'Too many failed attempts. Try again in a few minutes.',
      next,
    });
  }

  const password = req.body.password || '';
  const hash = config.adminPasswordHash;
  const ok = hash && bcrypt.compareSync(password, hash);

  if (!ok) {
    recordFailure(ip);
    return res.status(401).render('admin/login', {
      title: 'Admin login',
      error: 'Incorrect password.',
      next,
    });
  }

  clearAttempts(ip);
  req.session.regenerate((err) => {
    if (err) return res.status(500).send('Session error');
    req.session.isAdmin = true;
    res.redirect(next.startsWith('/') ? next : '/admin');
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

router.use(requireAdmin);

router.get('/', (req, res) => {
  const pending = getPending();
  res.render('admin/dashboard', { title: 'Admin · Pending submissions', pending });
});

router.get('/submissions/:id', (req, res) => {
  const submission = getById(req.params.id);
  if (!submission) return res.status(404).render('404', { title: 'Not found' });
  res.render('admin/submission-detail', {
    title: `Admin · Submission #${submission.id}`,
    submission,
    CARDS,
    BACKENDS,
    RUNTIMES,
    TRISTATE,
    errors: {},
  });
});

router.post('/submissions/:id/approve', (req, res) => {
  setStatus(req.params.id, 'verified');
  res.redirect('/admin');
});

router.post('/submissions/:id/reject', (req, res) => {
  setStatus(req.params.id, 'rejected');
  res.redirect('/admin');
});

router.post('/submissions/:id/edit', (req, res) => {
  const { valid, errors, data } = require('../lib/validate').validateSubmission(req.body);
  if (!valid) {
    const submission = { ...getById(req.params.id), ...req.body };
    return res.status(400).render('admin/submission-detail', {
      title: `Admin · Submission #${req.params.id}`,
      submission,
      CARDS,
      BACKENDS,
      RUNTIMES,
      TRISTATE,
      errors,
    });
  }
  updateSubmission(req.params.id, { ...data, admin_notes: req.body.admin_notes || null });
  res.redirect(`/admin/submissions/${req.params.id}`);
});

module.exports = router;
