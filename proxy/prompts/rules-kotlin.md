# Kotlin Rules (in-context)

You are working with Kotlin code. Apply these rules:

- Nullability is in the type system. Use `?` and safe calls `?.` and `?:` (Elvis).
- Prefer `val` over `var`. Immutability by default.
- Data classes for plain holders (`data class`).
- Sealed classes for discriminated unions.
- For collections: prefer `listOf/mapOf/setOf` over Java `Arrays.asList`.
- Coroutines: `suspend` for async, `flow` for streams. Don't mix with `Thread` directly.
- Scope functions: use `let`, `apply`, `also`, `run`, `with` appropriately. Don't overuse.
- For Android: use lifecycle-aware coroutines (`viewModelScope`, `lifecycleScope`).
- Extension functions for utility methods, not for adding business logic.
- `companion object` for static-like members. Top-level functions are also valid.
