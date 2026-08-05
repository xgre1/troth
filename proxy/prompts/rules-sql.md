# SQL/Database Rules (in-context)

You are working with SQL or database code. Apply these rules:

- Use prepared statements/parameter binding. NEVER concatenate user input into queries.
- For better-sqlite3: use `db.prepare(sql).run(args)` or `.get(args)`. Don't use `db.exec()` for user data.
- Wrap multi-statement updates in `db.transaction(() => { ... })()` for atomicity.
- Add indexes for any column used in WHERE/JOIN. Check with `EXPLAIN QUERY PLAN`.
- Always handle the case where a query returns no rows (`.get()` returns `undefined`).
- Use foreign key constraints + `ON DELETE CASCADE` to prevent orphan rows.
