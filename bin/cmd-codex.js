// SPDX-License-Identifier: AGPL-3.0-only
// Extracted verbatim from bin/troth.js (command block: codex).
// Keeps its own `if (command === ...)` guard; called unconditionally by the
// CLI router in the original chain position, so flow is identical.
module.exports = function run(ctx) {
const { args, command } = ctx;
if (command === "codex") {
  var subCmd = args[1] || "status";
  var tokenStore = require("../shared-core/codex-token-store.js");
  if (subCmd === "login") {
    var auth = require("../shared-core/codex-auth.js");
    process.stdout.write(
      "Signing in to YOUR ChatGPT account. It spends your own subscription quota.\n" +
      "troth is not affiliated with OpenAI, and this interface is not documented for\n" +
      "third-party clients, so it can change without notice. See docs/SETUP_GUIDE.md.\n" +
      "\nopening browser for ChatGPT sign-in...\n");
    auth.login().then(function (tok) {
      process.stdout.write("\nsigned in. token saved to " + tokenStore.tokenPath() + "\n");
      if (tok.account_id) process.stdout.write("account_id: " + tok.account_id + "\n");
      // The token alone is not enough: the router skips any provider without
      // enabled:true, so this command used to sign someone in and leave them
      // with no engine — while `troth doctor` counted the bare token as a
      // configured provider, so the two layers disagreed about the same
      // install. proxy/server.js fixed this for the dashboard sign-in only.
      // No model is seeded; the providers default carries the working one.
      try {
        require("../shared-core/config-file.js").updateConfig(function (current) {
          current.providers = Object.assign({}, current.providers);
          current.providers.openai_sub = Object.assign(
            {}, current.providers.openai_sub || {}, { enabled: true });
          return current;
        });
        process.stdout.write("ChatGPT subscription enabled in " +
          require("../shared-core/config-file.js").configPath() + "\n");
      } catch (e) {
        process.stdout.write("token saved, but enabling the provider failed: " +
          (e && e.message || e) + "\nEnable \"ChatGPT subscription\" in the dashboard.\n");
      }
      process.exit(0);
    }).catch(function (e) {
      process.stderr.write("\nlogin failed: " + (e && e.message || e) + "\n");
      process.exit(1);
    });
  } else if (subCmd === "logout") {
    tokenStore.clear();
    process.stdout.write("logged out — token at " + tokenStore.tokenPath() + " removed\n");
    process.exit(0);
  } else if (subCmd === "status") {
    var t = tokenStore.load();
    if (!t) {
      // Pointing at a sign-in that cannot run is worse than saying why.
      if (!require("../shared-core/codex-auth.js").clientId()) {
        process.stdout.write("not configured. the OAuth client id is blank;\n" +
          "unset TROTH_CODEX_CLIENT_ID to use the default, or write your own to\n" +
          "~/.troth/codex-client-id. see \"ChatGPT subscription\" in docs/SETUP_GUIDE.md.\n");
        process.exit(0);
      }
      process.stdout.write("not signed in. run `troth codex login` to authenticate.\n");
      process.exit(0);
    }
    var expired = tokenStore.isExpired(t);
    var ttlSec = Math.max(0, Math.round((t.expires_at - Date.now()) / 1000));
    process.stdout.write("signed in.\n");
    process.stdout.write("  account_id: " + (t.account_id || "(none)") + "\n");
    process.stdout.write("  scope:      " + (t.scope || "(none)") + "\n");
    process.stdout.write("  expires_in: " + ttlSec + "s" + (expired ? " (EXPIRED — refresh needed on next call)" : "") + "\n");
    process.stdout.write("  token_path: " + tokenStore.tokenPath() + "\n");
    process.exit(0);
  } else {
    process.stderr.write("usage: troth codex (login|logout|status)\n");
    process.exit(2);
  }
}
};
