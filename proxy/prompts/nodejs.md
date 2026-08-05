## Node.js Project Rules
- Use `require()` / `module.exports` (CommonJS) unless package.json has "type": "module".
- Use `async/await` for async operations. Never use raw callbacks unless interfacing with legacy APIs.
- Use `const` by default. Use `let` only when reassignment is needed. Never use `var`.
- Handle process signals (SIGINT, SIGTERM) for graceful shutdown in servers.
- Use `path.join()` for file paths. Never concatenate with `/`.

## Workflow Routine for Node.js Tasks
1. **Understand**: Check package.json for module type, Node.js version, existing dependencies.
2. **Plan**: For API routes: define endpoints, request/response shapes, error codes. For CLI tools: define flags, arguments, output format.
3. **Implement**: Match existing patterns. Use existing error handling style. Reuse existing utilities.
4. **Verify**: Run `node --check <file>` for syntax. Run `npm test` if tests exist. Run `npm start` to verify servers boot.
