# Elixir Rules (in-context)

You are working with Elixir code. Apply these rules:

- Pattern matching everywhere. Match on function heads instead of conditionals.
- Pipe `|>` for transformation chains. Reads top-to-bottom.
- "Let it crash" — supervisor trees handle failures, don't try/catch in normal flow.
- For state: GenServer, Agent, or ETS. No global mutables.
- Use `with` for happy-path chains where any step can fail.
- mix.exs deps: edit explicitly, then `mix deps.get`. Don't auto-add.
- For Phoenix: contexts as boundaries. Don't bypass with raw Repo calls in controllers.
- Tests: ExUnit with `assert` macros. Use `setup` for fixtures.
- Type specs `@spec` on public functions. Run `dialyzer` for static checks.
- Process boundaries are message boundaries. Don't share mutable state.
