# PR #5 validation report

## Latest isolated component-test status

Reviewed branch: `feat/wexelorchester-multiprocess`  
Reviewed head at the start of this update: `2317eacedbda71b56a3a43e26218508de8c6a38b`  
Date: 2026-10-18

The requested scope is limited to these two Vitest files, not the full package:

- `packages/wexel/src/filesystem-memory64.test.ts`
- `packages/wexel/src/wexel-orchester.test.ts`

The intended focused command, from `packages/wexel`, is:

```bash
node --experimental-wasm-memory64 ../../node_modules/vitest/vitest.mjs run src/filesystem-memory64.test.ts src/wexel-orchester.test.ts --pool=threads --poolOptions.threads.singleThread
```

**Result: NOT RUN TO COMPLETION.** The available execution container has Node.js v22.16.0 and npm 10.9.2, but no repository checkout, no local `node_modules/vitest/vitest.mjs`, and no cached Vitest package. Installing Vitest with npm was attempted but could not complete because external network/DNS access is unavailable. A filesystem search also found no installed Vitest runner. Therefore no pass/fail result is claimed for either test file. This is an execution-environment blocker, not evidence that the tests themselves fail.

The package build, typecheck, and full test suite were deliberately not run because they are outside the requested validation scope. No GitHub Actions workflow or Vercel runner was used.

## Previously executed Core Memory64 checks

These checks were executed directly against the compiled WASM artifact in an earlier review session. They do not substitute for the two Vitest files above.

- **Core Memory64 artifact smoke test:** verified the artifact exports 64-bit pointers, reports a 16 GiB configured limit, starts with 16 MiB of linear memory, allocates/frees/reuses a block, and grows linear memory to 16 GiB.
- **Allocator stress test:** 20,000 deterministic randomized allocate/free operations completed without overlapping live allocations or payload corruption.
- **Allocator edge checks:** rejected invalid limits, accepted a page-aligned 32 MiB limit, handled a zero-byte allocation, ignored a double free, preserved another live block's payload, and rejected growth beyond the configured limit.
- **File URL regression reproduction:** confirmed that `readFile(fileUrlString)` fails with `ENOENT` in Node.js, while `readFile(new URL(fileUrlString))` reads the artifact bytes correctly.

The 16 GiB check grew linear memory but did not write 16 GiB of file payload. These checks did not execute the TypeScript VFS integration test or WexelOrchester child-process/IPC tests.

## Fresh load test executed on the compiled Memory64 artifact

Executed directly with Node.js v22.16.0 against `build-memory64/wexel-core-memory64.wasm`, without Vitest:

- **100,000 allocator operations passed**.
- 50,589 allocations and 49,411 frees.
- Peak of 1,201 simultaneous live blocks.
- 26,216,175 cumulative payload bytes written and verified.
- No overlapping live allocations and no payload corruption.
- All remaining live blocks were verified and freed during cleanup.
- Measured throughput: **30,909 operations/second** (3,235.3 ms total in this run).

The existing artifact smoke test also passed: 64-bit pointers, configured 16 GiB limit, allocation/free/reuse, and growth of linear memory to 16 GiB. The 16 GiB check grows virtual linear memory; it does not write 16 GiB of payload. A separate worker-process test passed for two distinct child processes, IPC requests/results, process isolation, and graceful shutdown.

The worker-process test exercises the process protocol harness, not the full `WexelOrchester` TypeScript class. The two original Vitest files are not represented as having passed.

The current PR also forwards serializable WebPink options to each worker and enforces `permissions.network` through the worker's `networkFetch`. A custom `WebPinkOptions.fetcher` function cannot be serialized across IPC and is not forwarded; workers use the global `fetch` unless a serializable WebPink policy/configuration is provided.

## Static-review findings fixed in the PR

- Preserved the terminal `failed` state when destroying a sandbox whose child process had already exited; a regression test was added.
- Bounded the final shutdown wait when a worker entry point cannot be spawned; a regression test was added.
- Fixed home-path normalization so `/` and `///` cannot become an empty string and bypass validation; a regression test was added.

## Final conclusion

The Core Memory64 artifact and allocator checks listed above passed, and the static-review fixes are present in the PR. The two requested Vitest files remain **unverified** because the runner could not be made available in the isolated environment. This report does not mark PR #5 fully validated, and the PR remains open and unmerged.
