# Swift Rules (in-context)

You are working with Swift code. Apply these rules:

- Optionals: prefer `if let` / `guard let` over force-unwrap `!`. Force-unwrap is a code smell.
- Use `guard` for early returns. Avoid deep nesting.
- Value types (struct) by default. Use class only when reference semantics needed.
- Protocols over inheritance. Protocol-oriented programming.
- For concurrency: use `async/await` (Swift 5.5+), `Task`, `actor` for shared state.
- Memory: `[weak self]` in closures that escape, especially in Combine/SwiftUI.
- SwiftUI: views are value types. State management with `@State`, `@Binding`, `@ObservedObject`, `@StateObject`.
- For Codable: use property wrappers like `@CodingKey` instead of manual `init(from:)`.
- Errors: throw typed errors (own enum conforming to Error), not strings.
- No global mutable state. Inject dependencies.
