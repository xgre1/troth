// SPDX-License-Identifier: AGPL-3.0-only
// app-detect.js — is the troth desktop app installed on THIS machine?
//
// Drives the dashboard's A1 topology split (app installed → Observatory mode,
// read-only cards pointing at the app; no app → the full control plane, the
// open-repo user's only GUI). The old check was a literal existsSync on
// /Applications/troth.app — a non-admin user who drags the app to
// ~/Applications (or runs it straight from the DMG/Downloads) was misdetected
// as "no app" and got a SECOND, conflicting control plane (portability audit
//  #7).
//
// Detection, in order:
//   1. STRUCTURAL — this very proxy runs from inside a .app bundle
//      (…/troth.app/Contents/Resources/core/…): the app is installed wherever
//      that bundle is, no path guessing at all.
//   2. Standard install dirs: /Applications and ~/Applications.
// A renamed bundle at an exotic path while a SEPARATE repo checkout serves
// the proxy stays undetected — accepted edge, the Observatory toggle remains
// available manually.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_REL = path.join("troth.app", "Contents", "MacOS", "troth-app");

function detectAppInstalled(fromFile) {
  const self = fromFile || __filename;
  // 1. Running from inside the bundle: derive the bundle root from our own
  //    path — works at ANY install location, including Downloads/translocation.
  const marker = self.indexOf(path.join("troth.app", "Contents"));
  if (marker !== -1) {
    const bundleRoot = self.slice(0, marker + "troth.app".length);
    try {
      if (fs.existsSync(path.join(bundleRoot, "Contents", "MacOS", "troth-app"))) return true;
    } catch (_) { /* fall through to the dir probes */ }
  }
  // 2. The two standard macOS install locations.
  for (const dir of ["/Applications", path.join(os.homedir(), "Applications")]) {
    try {
      if (fs.existsSync(path.join(dir, APP_REL))) return true;
    } catch (_) { /* keep probing */ }
  }
  return false;
}

module.exports = { detectAppInstalled };
