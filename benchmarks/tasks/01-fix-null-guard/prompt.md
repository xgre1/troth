There is a bug in `src/metrics.js`. Running `npm test` fails with a TypeError because `peakValue` crashes on samples whose `value` is `null` (the metrics probe returns null when it fails, and that data does reach production).

Fix `peakValue` so it ignores null-valued samples. Don't change the function signature, don't change the test file, don't add new dependencies. After your fix, `npm test` must pass.
