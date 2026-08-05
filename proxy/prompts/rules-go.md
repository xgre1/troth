# Go Rules (in-context)

You are working with Go code. Apply these rules:

- Errors are values: `if err != nil { return ..., err }` — never panic for normal errors.
- `defer` for cleanup (close files, unlock mutexes). Never forget.
- Goroutines must be bounded. No `for { go work() }` — use a worker pool or `errgroup`.
- Context: pass `ctx context.Context` as first param. Honor cancellation.
- Interfaces: small, defined by consumer. Don't pre-declare giant interfaces "for flexibility".
- For pointers: receivers should be consistent across methods (all pointer or all value).
- `sync.Mutex` for shared state. `sync/atomic` for counters. Channels for handoff.
- gofmt + golangci-lint must pass. No raw `fmt.Println` debug in committed code.
- Error wrapping: `fmt.Errorf("doing X: %w", err)` to preserve chain.
