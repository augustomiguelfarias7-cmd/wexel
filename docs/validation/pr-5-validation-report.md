# PR #5 validation report

Commit tested: `a2eb54fe860c869889e2b5ffca94f3f72b09c162`
Runtime: Node.js v22.16.0
Date: 2026-10-17

## Executed successfully

- **Core Memory64 artifact smoke test:** verified the artifact exports 64-bit pointers, reports a 16 GiB configured limit, starts with 16 MiB of linear memory, allocates/frees/reuses a block, and grows linear memory to 16 GiB.
- **Allocator stress test:** 20,000 deterministic randomized allocate/free operations completed without overlapping live allocations or payload corruption.
- **Allocator edge checks:** rejected invalid limits, accepted a page-aligned 32 MiB limit, handled a zero-byte allocation, ignored a double free, preserved another live block's payload, and rejected growth beyond the configured limit.
- **File URL regression reproduction:** confirmed that `readFile(fileUrlString)` fails with `ENOENT` in Node.js, while `readFile(new URL(fileUrlString))` reads the artifact bytes correctly.

These tests exercised the committed WASM artifact directly. The 16 GiB check grew linear memory but did not write 16 GiB of file payload.

## Not executed

- Full Vitest suite (`npm test`).
- Package build and TypeScript typecheck.
- The actual TypeScript VFS integration test against the compiled Core artifact.
- The committed `WexelOrchester` child-process/IPC tests.

The checkout/dependency environment available for this review has no repository working tree, Vitest or `@types/node` installation, and network/DNS access to GitHub and npm is unavailable. GitHub reported no workflow runs and no commit statuses for the tested commit, so there is no remote CI result to rely on.

## Static-review finding requiring follow-up

In `ManagedSandbox`, an unexpected child exit sets `status = "failed"` and resolves the exit promise. If `destroySandbox()` is then called, `stop()` overwrites the status with `"stopping"`; its wait resolves immediately because the exit promise is already resolved, so the status can remain `"stopping"` permanently on a retained sandbox reference. Add a regression test for an unexpectedly exiting worker and preserve a terminal status when stopping an already-exited child.

## Conclusion

The Core Memory64 artifact and allocator checks listed above passed. This does **not** establish that the full PR passes: Vitest, build/typecheck, real VFS integration, and actual worker IPC remain unverified, and the lifecycle issue above should be fixed before treating the PR as ready.
