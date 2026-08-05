# troth-bash — Sandboxed Bash with output compression

**Problem**: Claude Code's built-in `Bash` tool dumps the full raw output of every command into the session. A single `git log --oneline -100` can add 10K tokens; `grep -r foo src/` can add 50K. There is no official hook to intercept the tool output before it pollutes the context.

**Solution**: Expose a drop-in replacement as an MCP server (`mcp__troth-bash__run`), and ask the user to add `"Bash"` to the deny list so the agent is *forced* to route shell work through this sandbox. 100% deterministic replacement (the research-verified 30% prompt-steering failure rate of prompt-only approaches doesn't apply).

## What it does differently

| Scenario | Raw Bash tool | troth-bash |
|---|---|---|
| `git log --oneline -500` | 500 lines streamed in | head 50 + tail 20 + `[… 430 commits trimmed …]` |
| `git diff HEAD~10` | every hunk in full | first hunk per file + `[… N hunks trimmed in path …]` |
| `grep -r "foo" src/` | every match | first 180 + `[… N additional matches across M files trimmed …]` |
| `find . -type f` | every path | first 120 + trimmed marker |
| `cat big.log` | whole file | head 80 + tail 40 + trimmed marker |
| `ls`, `pwd`, `echo …` | unchanged | unchanged (under 4KB → pass-through) |

The raw output is also archived to `~/.troth/state.db` (`tool_output_archive` table). A future `bash_recall(archive_id)` tool can drill into specific sections on demand.

## Enable the deny list (required for real wins)

Add this to your `~/.claude/settings.json`:

```json
{
  "permissions": {
    "deny": ["Bash"]
  }
}
```

Now Claude Code will route every shell operation through `mcp__troth-bash__run` automatically.

## Trade-offs

- **Transparency**: the agent sees a footer `[troth-bash] compressed X → Y bytes (Z% saved), archive_id=N` so it knows compression happened and could theoretically drill in.
- **Persistence**: `cwd` is remembered across `run` calls. Use the `cd` tool to change it explicitly.
- **Exit codes**: preserved. stderr concatenated after stdout separated by `---`. Timeout status surfaced in the metadata header.

## Telemetry

Every compressed call writes to `savings_ledger` with `kind='bash_compression'` and the saved byte count. `troth stats` will roll this up once wired in.
