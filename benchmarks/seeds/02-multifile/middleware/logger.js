// SPDX-License-Identifier: AGPL-3.0-only
function logger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (process.env.NODE_ENV !== 'test') {
      console.log(`${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
    }
  });
  next();
}

module.exports = { logger };
