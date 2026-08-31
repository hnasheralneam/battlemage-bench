module.exports = function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin === true) {
    return next();
  }
  const next_ = encodeURIComponent(req.originalUrl);
  res.redirect(`/admin/login?next=${next_}`);
};
