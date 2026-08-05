// SPDX-License-Identifier: AGPL-3.0-only
const crypto = require('crypto');
const SECRET = 'demo-secret-key';

function signToken(userId, username) {
  const payload = Buffer.from(JSON.stringify({ userId, username, iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  const [payload, sig] = (token || '').split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()); }
  catch { return null; }
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  const user = verifyToken(auth.slice(7));
  if (!user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  next();
}

module.exports = { signToken, verifyToken, authMiddleware };
