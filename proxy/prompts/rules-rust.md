# Rust Rules (in-context)

You are working with Rust code. Apply these rules:

- `Result<T, E>` for fallible operations, `Option<T>` for nullable. Never `unwrap()` outside tests/`main()`.
- Use `?` for propagation. `anyhow::Error` for apps, `thiserror` for libraries.
- Borrowing: prefer `&str` over `String`, `&[T]` over `Vec<T>` in function signatures.
- `clone()` is a code smell — investigate why first. Often `Cow<'_, str>` or borrowing solves it.
- Lifetimes: only annotate when compiler asks. Don't preemptively add `'a`.
- For async: `tokio` is standard. Don't mix runtimes. Always `.await` futures.
- `cargo clippy --all-targets --all-features -- -D warnings` must pass.
- Match exhaustiveness: handle all variants OR explicit `_ => {}` with comment.
