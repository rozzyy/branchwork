# Code generation rules for Branchwork

Apply these rules whenever you generate, edit, or review application code.

## Performance and complexity

- Identify the input dimensions for each non-trivial path (files, commits, worktrees, rows, requests, or bytes).
- State expected time and space complexity with Big O notation when a path traverses or transforms variable-sized data. Include the relevant dimensions, such as `O(files + changed_paths)` or `O(commits × entries)`.
- Look for nested scans, repeated sorting, per-item Git/process/network calls, duplicate reads, and repeated React effects. Prefer indexed lookups, batching, incremental work, and reuse of fresh results where correctness permits.
- Bound parallel work. Do not create one task, request, process, or large buffer per input item without an explicit safe limit.
- Paginate or lazily load large collections. Bound response bytes, file sizes, execution time, retries, and retained cache size.
- Keep expensive filesystem, Git, process, and network work off the WebView main thread. For Tauri handlers, use the repository's async command pattern; avoid blocking Tokio workers for long or highly concurrent tasks when a blocking pool is appropriate.
- Avoid recomputing large derived data during React renders. Keep effects specific to the active view and input, and prevent stale requests from replacing newer state.
- For a suspected hot path, inspect realistic large inputs and measure it when feasible. Report measured results separately from complexity estimates; do not claim an improvement from code inspection alone.

## Security and scalability

- Treat every IPC argument, filesystem path, Git ref, URL, and subprocess argument as untrusted. Validate at the backend boundary and use fixed argument arrays; never interpolate user input into a shell command.
- Keep credentials and tokens in the existing secure storage path. Do not serialize them to the WebView, logs, errors, or generated fixtures.
- Set limits on input size, output size, runtime, pagination, retries, concurrency, and in-memory state where an input can grow or an external service can stall.
- Check how the implementation behaves across many files, commits, worktrees, panes, accounts, and repeated refreshes—not just the small happy path.
- Preserve path containment, least privilege, and existing authorization checks when batching, caching, or moving work across threads.

## Per-change checklist

Before calling code complete, record:

1. The variable input dimensions and the time/space growth for non-trivial work.
2. Any unbounded traversal, fan-out, payload, cache, retry, or blocking operation and how it is bounded.
3. The security boundary and validation for external or IPC input.
4. What was measured or checked. If no benchmark was run, label performance conclusions as estimates.
