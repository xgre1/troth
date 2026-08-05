# TypeScript Rules (in-context)

You are working with TypeScript code. Apply these rules:

- NEVER use `any` — use `unknown` if you must, then narrow with type guards.
- NEVER use `@ts-ignore` or `@ts-expect-error` without a comment explaining why.
- Prefer interfaces for public APIs, types for unions/intersections.
- Use `readonly` arrays/properties when data shouldn't mutate (default to readonly).
- Discriminated unions over boolean flags for state: `{ status: 'loading' } | { status: 'error', error: Error } | { status: 'success', data: T }`.
- For async functions, declare return type explicitly: `async function foo(): Promise<Result>`.
- Use `satisfies` to validate against a type without widening (TS 4.9+).
- Don't import from `.ts` files — let the bundler handle extensions.
- Strict null checks must be respected: handle `undefined`/`null` explicitly.
