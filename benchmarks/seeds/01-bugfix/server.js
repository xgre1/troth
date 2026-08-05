// SPDX-License-Identifier: AGPL-3.0-only
const express = require('express');
const Database = require('better-sqlite3');
const app = express();

app.use(express.json());

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    priority TEXT DEFAULT 'low' CHECK(priority IN ('low', 'medium', 'high')),
    status TEXT DEFAULT 'todo' CHECK(status IN ('todo', 'in-progress', 'done')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// BUG 1: GET /tasks ignores query filters entirely
app.get('/tasks', (req, res) => {
  const rows = db.prepare('SELECT * FROM tasks').all();
  res.json(rows);
});

// BUG 2: POST /tasks doesn't validate required fields
app.post('/tasks', (req, res) => {
  const { title, description, priority } = req.body;
  const result = db.prepare(
    'INSERT INTO tasks (title, description, priority) VALUES (?, ?, ?)'
  ).run(title, description || '', priority || 'low');
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(task);
});

// BUG 3: PUT /tasks/:id returns 200 even when task doesn't exist
app.put('/tasks/:id', (req, res) => {
  const { status, title, priority } = req.body;
  const updates = [];
  const values = [];
  if (status) { updates.push('status = ?'); values.push(status); }
  if (title) { updates.push('title = ?'); values.push(title); }
  if (priority) { updates.push('priority = ?'); values.push(priority); }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  res.json(task);
});

app.delete('/tasks/:id', (req, res) => {
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Task not found' });
  res.status(204).send();
});

// BUG 4: Stats endpoint counts wrong — groups by priority instead of status
app.get('/tasks/stats', (req, res) => {
  const stats = db.prepare(
    'SELECT priority as group_key, COUNT(*) as count FROM tasks GROUP BY priority'
  ).all();
  res.json(stats);
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
module.exports = app;
