// SPDX-License-Identifier: AGPL-3.0-only
const router = require('express').Router();

router.get('/', (req, res) => {
  const users = req.app.locals.db.prepare('SELECT id, username, created_at FROM users').all();
  res.json(users);
});

router.get('/:id', (req, res) => {
  const user = req.app.locals.db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json(user);
});

module.exports = router;
