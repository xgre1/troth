// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// host.hypervisor pluggable backend (dev-only Docker shim).
//
// Tagged dev_only:true so the production resolver refuses to use this as
// the live host backend. Production backend ships separately.
//
// Anti-drift: this is NOT a production host. It must never become "the
// partner is an agent in a container". launch() throws unless explicitly
// allowed in a dev harness.
const { execSync } = require('child_process');

function dockerPresent() {
  try { execSync('docker info', { stdio: 'ignore', timeout: 4000 }); return true; }
  catch (_) { return false; }
}

module.exports = {
  name: 'docker',
  dev_only: true,

  probe() {
    return { backend: 'docker', available: dockerPresent(), dev_only: true };
  },

  // This backend does NOT boot a production host. Guard hard so it can't
  // silently become the production launcher.
  launch(/* image, vsock */) {
    if (process.env.TROTH_ALLOW_DEV_HYPERVISOR !== '1') {
      throw new Error('host.hypervisor(docker) is dev_only — set TROTH_ALLOW_DEV_HYPERVISOR=1 for a dev harness; production backend ships separately');
    }
    throw new Error('host.hypervisor(docker).launch: dev-only backend; production host ships separately');
  },
  snapshot() { throw new Error('host.hypervisor(docker).snapshot: unsupported (dev_only)'); },
  halt() { throw new Error('host.hypervisor(docker).halt: unsupported (dev_only)'); },
  screencast() { throw new Error('host.hypervisor(docker).screencast: unsupported (dev_only)'); },
};
