// SPDX-License-Identifier: AGPL-3.0-only
// Continuous AX-tree browser observer — THE green-field
// perception piece. Polarity-inversion: substrate observes the browser
// independently of the language faculty, writes perception engrams,
// faculty reads engrams when it wakes. Faculty does NOT trigger
// browser snapshots.
//
// Substrate-thesis anti-drift check:
//   If you can describe the data flow as "faculty → tool call → tool
//   response," the design has failed. This observer:
//     - Runs in the substrate's event loop, started at boot.
//     - Subscribes to CDP events from the always-on Chromium daemon.
//     - Writes engrams INDEPENDENT of whether faculty is awake.
//     - The faculty reads engrams from substrate, never invokes this
//       observer as a synchronous tool.
//
// Selective observation policy (component 2 spec):
//   Write engrams when:
//     - Page navigation completes        → page_visit
//     - Form structure change            → field_capture
//     - DOM mutation crosses semantic-delta threshold → perception_event(mutation)
//     - Network response matches policy  → perception_event(network)
//     - Console signals from page-script → perception_event(console)
//   Pure style churn / repaint / animation = DROPPED.
//   Operator-signed policy engram can tighten or loosen the defaults.

'use strict';

const cdp = require('./cdp-client.js');
const schemas = require('./engram-schemas.js');

const DEFAULT_HOST = '127.0.0.1';
// Private Troth CDP port (see chromium-daemon.js), NOT Chrome's 9222 — fallback
// only; the daemon resolves the real port into TROTH_BROWSER_CDP_PORT.
const DEFAULT_PORT = 18222;
const MUTATION_DEBOUNCE_MS = 250;

class BrowserObserver {
  constructor(opts) {
    opts = opts || {};
    this.host = opts.host || process.env.TROTH_BROWSER_CDP_HOST || DEFAULT_HOST;
    this.port = parseInt(opts.port || process.env.TROTH_BROWSER_CDP_PORT || DEFAULT_PORT, 10);
    // Caller-injected engram writer: function(engram) → Promise. Lets
    // substrate route through its existing engram pipeline (with
    // class-based recall, audience enforcement, STVC, etc.) instead
    // of us reaching into engram internals.
    this.writeEngram = opts.writeEngram || function (_e) {};
    // Optional: caller-injected logger so we can be observed without
    // pulling in a specific logger module.
    this.log = opts.log || function () {};
    this.session = null;
    this._lastAxHash = null;
    this._mutationTimer = null;
    this._stopped = false;
  }

  async start({ maxRetries = 30, retryDelayMs = 1000 } = {}) {
    // Chromium may not be ready instantly at boot; init spawns the
    // daemon AFTER substrate exec, so substrate's observer may need
    // to wait briefly for the CDP listener to come up.
    let attempt = 0;
    let lastErr = null;
    while (attempt < maxRetries && !this._stopped) {
      try {
        this.session = await cdp.connectFirstPage(this.host, this.port);
        break;
      } catch (e) {
        lastErr = e;
        attempt++;
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
    if (!this.session) {
      this.log('browser-observer: failed to connect after ' + maxRetries + ' attempts: ' + (lastErr && lastErr.message));
      return false;
    }
    this.log('browser-observer: connected to ' + this.host + ':' + this.port);

    // Enable the CDP domains we use.
    await this.session.send('Page.enable');
    await this.session.send('DOM.enable');
    await this.session.send('Accessibility.enable');
    await this.session.send('Network.enable');
    await this.session.send('Runtime.enable');

    // Wire event subscribers.
    this.session.on('Page.frameNavigated', (params) => this._onFrameNavigated(params));
    this.session.on('DOM.documentUpdated', () => this._scheduleSemanticSnapshot('dom_documentUpdated'));
    this.session.on('Network.responseReceived', (params) => this._onNetworkResponse(params));
    this.session.on('Runtime.consoleAPICalled', (params) => this._onConsole(params));

    this.session.onClose(() => {
      this.log('browser-observer: CDP session closed');
      this.session = null;
    });

    return true;
  }

  async stop() {
    this._stopped = true;
    if (this._mutationTimer) clearTimeout(this._mutationTimer);
    if (this.session) try { this.session.close(); } catch (_) {}
    this.session = null;
  }

  // —— event handlers ————————————————————————————————————————————

  async _onFrameNavigated(params) {
    try {
      if (!params || !params.frame || params.frame.parentId) return;  // main frame only
      const url = params.frame.url;
      if (!url || url === 'about:blank') return;
      // Pull the AX-tree as our semantic snapshot.
      const { ax_node_count, semantic_summary, ax_graph_text } = await this._captureAxTree();
      const title = await this._safeTitle();
      const eng = schemas.pageVisit({
        url, title,
        ts: Date.now(),
        ax_node_count, semantic_summary, ax_graph_text,
      });
      this._lastAxHash = eng.payload.ax_graph_hash;
      await this.writeEngram(eng);
      this.log('page_visit ' + (title || url));
      // Phase 2 Component 7: WebMCP capability discovery.
      // On every navigation, probe /.well-known/webmcp.json — sites
      // that expose WebMCP declare an agent-facing API. When present,
      // we write a webmcp_site_capabilities engram so the goal-to-
      // action translator can prefer declared tools over synthesised
      // AX-tree actions next time. Best-effort, never blocks the
      // perception engram write.
      this._probeWebMcp(url).catch((_) => {});
    } catch (e) {
      this.log('frameNavigated handler error: ' + (e && e.message || e));
    }
  }

  async _probeWebMcp(navigatedUrl) {
    try {
      const u = new URL(navigatedUrl);
      const probeUrl = u.origin + '/.well-known/webmcp.json';
      // Use the in-page fetch via CDP so probing inherits page cookies
      // and respects CORS naturally (the probe is from the page itself).
      const expr = `(async function(u){try{const r=await fetch(u,{credentials:'omit'});if(!r.ok)return null;const j=await r.json();return j;}catch(e){return null;}})(${JSON.stringify(probeUrl)})`;
      const result = await this.session.send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
      });
      const j = result && result.result && result.result.value;
      if (!j) return;
      // WebMCP draft shape: top-level `tools` (array) OR `capabilities`.
      const caps = (j.tools || j.capabilities || []).map((c) => ({
        name:   c.name || c.id || 'unknown',
        schema: c.schema || c.parameters || null,
      })).filter((c) => c.name);
      if (!caps.length) return;
      await this.writeEngram(schemas.webmcpSiteCapabilities({
        host: u.hostname,
        capabilities: caps,
      }));
      this.log('webmcp_site_capabilities ' + u.hostname + ' (' + caps.length + ' tools)');
    } catch (_) { /* probe is purely opportunistic */ }
  }

  _scheduleSemanticSnapshot(reason) {
    // Debounce: heavy SPAs fire DOM.documentUpdated frequently; we
    // capture AX-tree at most once per MUTATION_DEBOUNCE_MS, and write
    // a perception_event only when the AX-tree hash actually changed.
    if (this._mutationTimer) return;
    this._mutationTimer = setTimeout(async () => {
      this._mutationTimer = null;
      try {
        const { ax_node_count, ax_graph_text, semantic_summary } = await this._captureAxTree();
        if (!ax_graph_text) return;
        const crypto = require('crypto');
        const newHash = crypto.createHash('sha256').update(ax_graph_text).digest('hex').slice(0, 16);
        if (newHash === this._lastAxHash) return;   // pure style/repaint churn, drop
        this._lastAxHash = newHash;
        await this.writeEngram(schemas.perceptionEvent({
          kind: 'mutation',
          payload: { reason, ax_node_count, semantic_summary, ax_graph_hash: newHash },
        }));
      } catch (e) {
        this.log('semantic snapshot error: ' + (e && e.message || e));
      }
    }, MUTATION_DEBOUNCE_MS);
  }

  async _onNetworkResponse(params) {
    try {
      const r = params && params.response;
      if (!r || !r.url) return;
      // V0 selectivity: log only 4xx/5xx + auth/oauth flows. Operator
      // policy will refine this; everything else dropped to stay below
      // the cost ceiling (component 2 spec: avoid flooding substrate).
      const interesting = (r.status >= 400)
                       || /\/(oauth|auth|login|sso|callback)/i.test(r.url);
      if (!interesting) return;
      await this.writeEngram(schemas.perceptionEvent({
        kind: 'network',
        payload: { url: r.url, status: r.status, mime: r.mimeType || null },
      }));
    } catch (e) {
      this.log('network response error: ' + (e && e.message || e));
    }
  }

  async _onConsole(params) {
    try {
      if (!params || !params.type) return;
      // Only errors + warnings; debug/info too noisy.
      if (params.type !== 'error' && params.type !== 'warning') return;
      const args = (params.args || []).map((a) => a.value != null ? String(a.value) : a.description).filter(Boolean);
      await this.writeEngram(schemas.perceptionEvent({
        kind: 'console',
        payload: { level: params.type, message: args.join(' ').slice(0, 500) },
      }));
    } catch (e) {
      this.log('console handler error: ' + (e && e.message || e));
    }
  }

  // —— helpers ————————————————————————————————————————————————

  async _captureAxTree() {
    try {
      const ax = await this.session.send('Accessibility.getFullAXTree');
      const nodes = ax && ax.nodes ? ax.nodes : [];
      // Sanitization gate (component 6). Chromium's AX-tree already
      // excludes display:none / visibility:hidden by design, so the
      // worst hidden-content injection vectors are pre-filtered. What
      // we still need to defend against at the perception layer:
      //   - ARIA-label overrides way longer than the visible text
      //     (semantic injection via accessibility overrides)
      //   - Imperative-instruction patterns in node names
      //     ("IGNORE PREVIOUS INSTRUCTIONS", "SYSTEM:", etc.)
      //   - Unicode bidi / homoglyph attacks
      //   - HTML-comment leakage if a node name was assembled from
      //     comment text
      // Per spec we STRIP outright on display/visibility, FLAG on
      // semantic patterns. Flagging surfaces via external_suspicious
      // engram so STVC can refuse promotion without explicit synthesis.
      const sanitized = [];
      const flags = [];
      for (const n of nodes) {
        const role = (n.role && n.role.value) || '';
        let name = (n.name && n.name.value) || '';
        if (!name) { sanitized.push(n); continue; }
        // Unicode normalize + strip bidi controls.
        const before = name;
        name = name.normalize('NFKC').replace(/[\u202A-\u202E\u2066-\u2069]/g, '');
        if (name !== before) flags.push('bidi_or_nfkc');
        // Long ARIA-label vs short visible-text heuristic — if name >
        // 5x the average and contains imperative keywords, flag.
        const imperativePattern = /(IGNORE\s+PREVIOUS|SYSTEM\s*:|YOU\s+ARE\s+NOW|IMPORTANT\s*[:!]|INSTRUCTIONS?\s*[:!])/i;
        if (imperativePattern.test(name)) flags.push('imperative_injection_pattern');
        // Strip HTML-comment leakage.
        const commentStripped = name.replace(/<!--[\s\S]*?-->/g, '');
        if (commentStripped !== name) {
          flags.push('html_comment_in_node_name');
          name = commentStripped;
        }
        sanitized.push(Object.assign({}, n, { name: { value: name } }));
      }
      // Cheap semantic summary: top-level role + name where present.
      const summary = [];
      for (const n of sanitized.slice(0, 50)) {
        const role = (n.role && n.role.value) || '';
        const name = (n.name && n.name.value) || '';
        if (role && name) summary.push(role + ': ' + String(name).slice(0, 80));
      }
      const graphText = sanitized
        .map((n) => ((n.role && n.role.value) || '') + '|' + ((n.name && n.name.value) || ''))
        .join('\n');
      // If sanitization flagged anything, write external_suspicious
      // engram alongside (audience=external_suspicious; STVC refuses
      // promotion to operator_confirmed without explicit synthesis).
      if (flags.length) {
        try {
          const schemas = require('./engram-schemas.js');
          await this.writeEngram(schemas.externalSuspicious({
            source_engram_class: 'page_visit',
            strip_rules_triggered: Array.from(new Set(flags)),
            original_size: nodes.length,
            sanitized_size: sanitized.length,
          }));
        } catch (_) {}
      }
      return {
        ax_node_count: sanitized.length,
        semantic_summary: summary.join('\n'),
        ax_graph_text: graphText,
      };
    } catch (e) {
      this.log('AX-tree fetch error: ' + (e && e.message || e));
      return { ax_node_count: 0, semantic_summary: null, ax_graph_text: '' };
    }
  }

  async _safeTitle() {
    try {
      const r = await this.session.send('Runtime.evaluate', { expression: 'document.title' });
      return (r && r.result && r.result.value) || null;
    } catch (_) { return null; }
  }
}

module.exports = { BrowserObserver };
