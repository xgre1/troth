# Ruby Rules (in-context)

You are working with Ruby code. Apply these rules:

- Use symbols for hash keys: `{name: 'foo'}` not `{'name' => 'foo'}`.
- Prefer `&:method_name` block shorthand: `arr.map(&:upcase)`.
- String interpolation `"hello #{name}"` over concatenation.
- `attr_reader/writer/accessor` instead of manual getters/setters.
- For Rails: use scopes for reusable queries, never raw SQL with user input.
- Migrations: always reversible (use `change` block when possible, otherwise `up`/`down`).
- No `monkey patches` of stdlib without justification — use refinements or wrappers.
- Bundler: don't add gems ad-hoc — edit Gemfile and bundle install.
- Use `safe navigation` `&.` for nil handling. Avoid `try`.
- Constants in CamelCase, methods/vars in snake_case, classes/modules in CamelCase.
