// SPDX-License-Identifier: AGPL-3.0-only
// Minimal Express-ish server using only the stdlib so the benchmark
// doesn't need npm install of anything beyond dev-deps. Serves /users
// as JSON today; the task adds /users.csv.
const http = require('http');

const users = [
  { id: 1, name: 'Ada Lovelace',       email: 'ada@ex.com',     role: 'admin'  },
  { id: 2, name: 'Grace Hopper',       email: 'grace@ex.com',   role: 'admin'  },
  { id: 3, name: 'Alan Turing',        email: 'alan@ex.com',    role: 'user'   },
  { id: 4, name: 'Donald Knuth',       email: 'don@ex.com',     role: 'user'   },
  { id: 5, name: 'Barbara Liskov',     email: 'barb@ex.com',    role: 'admin'  }
];

function handle(req, res) {
  if (req.method === 'GET' && req.url === '/users') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(users));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

const server = http.createServer(handle);
if (require.main === module) {
  server.listen(3001, () => console.log('listening on 3001'));
}
module.exports = { handle, users, server };
