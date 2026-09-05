// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every run stays off the operator's real substrate (a throwaway HOME).
require('./hermetic-db.js');
// Moved to tests/smoke/resilience.smoke.js. Kept as a thin alias so the old
// path + `npm run verify:resilience` still work. Run: `npm run smoke`.
require('./smoke/run.js');
