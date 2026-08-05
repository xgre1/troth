# Java Rules (in-context)

You are working with Java code. Apply these rules:

- Use Optional<T> for nullable returns. Never return null where the caller expects a value.
- Try-with-resources for any AutoCloseable (Connection, Stream, Reader, etc.).
- Prefer immutability: `final` fields, defensive copies of collections in getters.
- Use Lombok `@Builder`/`@Value` if the project does, else write builders by hand for >3 params.
- Streams over loops for transformations. But loop for side effects.
- ExecutorService — always shut down in finally. Never `new Thread()` directly in services.
- Use slf4j for logging, not System.out.
- Constants: `public static final` UPPER_SNAKE_CASE.
- Annotations: `@Override` on every override. `@Nullable`/`@NonNull` for clarity.
- Maven/Gradle: don't add dependencies without checking pom.xml/build.gradle is committed.
