// SPDX-License-Identifier: AGPL-3.0-only
const router = require('express').Router();

router.get('/', (req, res) => {
  const posts = req.app.locals.db.prepare(`
    SELECT p.*, u.username FROM posts p
    JOIN users u ON p.user_id = u.id
    ORDER BY p.created_at DESC
  `).all();
  res.json(posts);
});

router.post('/', (req, res) => {
  const { title, body } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'title and body required' });
  const result = req.app.locals.db.prepare(
    'INSERT INTO posts (user_id, title, body) VALUES (?, ?, ?)'
  ).run(req.user.userId, title, body);
  const post = req.app.locals.db.prepare('SELECT * FROM posts WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(post);
});

router.get('/:id', (req, res) => {
  const post = req.app.locals.db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'not found' });
  res.json(post);
});

module.exports = router;
