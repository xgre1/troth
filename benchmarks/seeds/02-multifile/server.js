// SPDX-License-Identifier: AGPL-3.0-only
const express = require('express');
const { initDb } = require('./db/index');
const { authMiddleware } = require('./middleware/auth');
const { logger } = require('./middleware/logger');
const usersRouter = require('./routes/users');
const postsRouter = require('./routes/posts');
const commentsRouter = require('./routes/comments');

const app = express();
app.use(express.json());
app.use(logger);

// Public routes
app.post('/auth/register', require('./routes/auth').register);
app.post('/auth/login', require('./routes/auth').login);

// Protected routes
app.use('/users', authMiddleware, usersRouter);
app.use('/posts', authMiddleware, postsRouter);
app.use('/comments', authMiddleware, commentsRouter);

const db = initDb();
app.locals.db = db;

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server on ${PORT}`));
}
module.exports = app;
