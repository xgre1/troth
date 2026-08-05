// SPDX-License-Identifier: AGPL-3.0-only
const router = require('express').Router();

router.get('/post/:postId', (req, res) => {
  const comments = req.app.locals.db.prepare(`
    SELECT c.*, u.username FROM comments c
    JOIN users u ON c.user_id = u.id
    WHERE c.post_id = ?
    ORDER BY c.created_at ASC
  `).all(req.params.postId);
  res.json(comments);
});

router.post('/', (req, res) => {
  const { post_id, body } = req.body;
  if (!post_id || !body) return res.status(400).json({ error: 'post_id and body required' });
  const result = req.app.locals.db.prepare(
    'INSERT INTO comments (post_id, user_id, body) VALUES (?, ?, ?)'
  ).run(post_id, req.user.userId, body);
  const comment = req.app.locals.db.prepare('SELECT * FROM comments WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(comment);
});

module.exports = router;
