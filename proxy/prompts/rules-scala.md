# Scala Rules (in-context)

You are working with Scala code. Apply these rules:

- Prefer immutable `val` over `var`. Mutation is a code smell.
- Pattern matching for control flow. Sealed traits + case classes for ADTs.
- Use `Option`, `Either`, `Try` for nullable/error cases. Avoid `null`.
- For collections: prefer `List`, `Vector`, `Map` (immutable). Use `mutable.*` only with cause.
- For-comprehensions for nested Option/Future/Either operations.
- Implicits: explicit `using` (Scala 3) or sparingly in Scala 2. Document why.
- Cats/ZIO if the project uses them — follow the FP idioms.
- For tests: ScalaTest with `should` matchers, or MUnit.
- sbt: don't add libraryDependencies ad-hoc. Edit build.sbt explicitly.
- Type annotations on public APIs. Local vars can use inference.
