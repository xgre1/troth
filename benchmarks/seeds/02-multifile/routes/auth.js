// SPDX-License-Identifier: AGPL-3.0-only
const crypto = require('crypto');
const { signToken } = require('../middleware/auth');

function hashPassword(pwd) {
  return crypto.createHash('sha256').update(pwd).digest('hex');
}

exports.register = (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const db = req.app.locals.db;
  try {
    const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hashPassword(password));
    res.status(201).json({ id: result.lastInsertRowid, username });
  } catch (e) {
    res.status(409).json({ error: 'username exists' });
  }
};

exports.login = (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const db = req.app.locals.db;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || user.password_hash !== hashPassword(password)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  res.json({ token: signToken(user.id, user.username) });
};
