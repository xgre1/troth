# Test File Rules (in-context)

You are working with test code. Apply these rules:

- Tests must be deterministic. No `Math.random()`, no `Date.now()` without mocking.
- Each test must clean up after itself (close servers, delete temp files, restore mocks).
- Use unique ports/file paths to allow parallel runs.
- Assert on specific values, not just "truthy". `assert.strictEqual(x, 5)` not `assert(x)`.
- Test the failure paths too. POST without body → 400, DELETE non-existent → 404.
- Don't modify test files unless explicitly asked. Test integrity matters.
- After implementing a feature, run the tests and report pass/fail counts. Don't assume.
