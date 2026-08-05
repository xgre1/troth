# PHP Rules (in-context)

You are working with PHP code. Apply these rules:

- Strict types: `declare(strict_types=1);` at the top of every file.
- Type hints on all parameters AND return types: `function foo(int $x): bool`.
- Use namespaces, follow PSR-4 autoloading. No `require_once` for app code.
- For DB: use PDO with prepared statements. NEVER concatenate user input into SQL.
- Composer: don't add deps ad-hoc — edit composer.json and `composer install`.
- For Laravel/Symfony: use the framework's idioms (Eloquent/Doctrine, Service Container, etc).
- Errors: throw typed exceptions, not generic `\Exception`. Catch specific.
- Constants: `const FOO = 'bar';` (not `define('FOO', 'bar');`) for class constants.
- Avoid `extract()`, `eval()`, `assert()` with strings.
- Sessions: regenerate ID on login. Never store secrets in session.
