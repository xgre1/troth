// SPDX-License-Identifier: AGPL-3.0-only
// web-research.js — provider-agnostic web research via the EXISTING CDP browser
// (real Chrome, JS-rendered, sanitized innerText extraction). NO vendor API, NO
// raw-HTML-into-context. Worldly tools so any native-tool-calling faculty
// (router/llamacpp/etc.) can research the web; claude_cli uses its own WebSearch.
//
// WHY this and not a Tavily/DuckDuckGo-scrape tool: the operator already built a
// full CDP browser system (perception/chromium-daemon.js + cdp-client.js +
// dispatchers/browser-do.js). The research-determined correct fetcher is OUR real
// Chrome driven by CDP — it renders JS-heavy pages and innerText extraction is the
// sanitization (no <script>, no hidden/off-screen text). No third-party runtime
// dependency, no key, no vendor lock.
//
// MODE: this is the Mode-1 (operator-cooperative) primitive — open web, operator
// in the loop. Results are tagged audience:'external' (untrusted). The Mode-2
// autonomous path uses the capability-gated intent:browser:do executor + the
// Decision-6 allowlist instead; do NOT route autonomous web through this tool.

const daemonMod = require('../perception/chromium-daemon.js');
const cdpMod    = require('../perception/cdp-client.js');

const NAV_WAIT_MS = () => parseInt(process.env.TROTH_WEB_NAV_WAIT_MS || '2800', 10) || 2800;
const MAX_CHARS   = () => parseInt(process.env.TROTH_WEB_MAX_CHARS   || '60000', 10) || 60000;

const CANCEL_POLL_MS = 100;

function _cancelAsked(ctx) {
  if (!ctx || typeof ctx.shouldCancel !== 'function') return false;
  try { return !!ctx.shouldCancel(); } catch (_) { return false; }
}

function _cancelled() {
  return { error: 'cancelled', interrupted: true, detail: 'the turn was stopped' };
}

async function _sleepUnlessCancelled(ms, ctx) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (_cancelAsked(ctx)) return false;
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(CANCEL_POLL_MS, until - Date.now()))));
  }
  return !_cancelAsked(ctx);
}

// Run fn(session) against a CDP page, ensuring the daemon + cleaning up. Returns
// fn's value, or a structured error envelope (never throws).
async function _withPage(fn, ctx) {
  if (_cancelAsked(ctx)) return _cancelled();
  // HEADFUL by default. Measured  on a real Mac: in HEADLESS CDP every
  // mainstream SERP blocks us (Brave→CAPTCHA, Ecosia→Cloudflare, Startpage→Blocked,
  // Mojeek→403) — headless is the single strongest bot signal. The SAME engines
  // return Google-grade results HEADFUL (our "body" Chrome is headful anyway).
  // Opt into headless only with TROTH_BROWSER_HEADLESS=1 (accepts the blocks).
  try { await daemonMod.ensure({ headless: process.env.TROTH_BROWSER_HEADLESS === '1' }); }
  catch (_) { /* env check below reports if CDP is unavailable */ }
  const port = process.env.TROTH_BROWSER_CDP_PORT;
  if (!port) {
    return { error: 'browser_cdp_unavailable', detail: 'no Chrome/Chromium launchable — install Google Chrome / Chromium or set TROTH_BROWSER_BIN.' };
  }
  const host = process.env.TROTH_BROWSER_CDP_HOST || '127.0.0.1';
  if (_cancelAsked(ctx)) return _cancelled();
  let session;
  try { session = await cdpMod.connectFirstPage(host, parseInt(port, 10)); }
  catch (e) { return { error: 'cdp_connect_failed', detail: String(e && e.message || e) }; }
  // The stop reaches a page mid-load by closing the CDP session: every send
  // still pending rejects at once (cdp-client's close handler), so a slow
  // navigation or evaluate never runs out its own timeout after the turn
  // was stopped.
  let hit = false;
  const watch = (ctx && typeof ctx.shouldCancel === 'function')
    ? setInterval(() => {
        if (hit || !_cancelAsked(ctx)) return;
        hit = true;
        try { session.close(); } catch (_) {}
      }, CANCEL_POLL_MS)
    : null;
  try {
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    const out = await fn(session);
    return (hit || _cancelAsked(ctx)) ? _cancelled() : out;
  } catch (e) {
    if (hit || _cancelAsked(ctx)) return _cancelled();
    return { error: 'cdp_op_failed', detail: String(e && e.message || e) };
  } finally {
    if (watch) clearInterval(watch);
    try { session.close(); } catch (_) {}
  }
}

async function _navExtract(session, url, expr, ctx) {
  await session.send('Page.navigate', { url });
  if (!(await _sleepUnlessCancelled(NAV_WAIT_MS(), ctx))) throw new Error('cancelled');
  const r = await session.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r && r.result && r.result.value;
}

// ── web_fetch (CDP) ───────────────────────────────────────────────────────
const fetchSchema = {
  type: 'function',
  function: {
    name: 'web_fetch',
    description: 'Fetch a web page (http/https) in a real browser and return its readable text (JS-rendered, scripts/hidden content stripped). Use to read a known docs/API/article URL or a web_search result. Read-only.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http:// or https:// URL.' } },
      required: ['url'],
    },
  },
};

async function runFetch(args, ctx) {
  args = args || {};
  const url = args.url;
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { error: 'bad_args', detail: 'url must be an absolute http:// or https:// URL' };
  }
  return _withPage(async (s) => {
    const text = await _navExtract(s, url, 'document.body ? document.body.innerText : ""', ctx);
    const content = String(text == null ? '' : text);
    // A page past the cap is cut, and the cut is SAID beside the content,
    // never written into it: a marker inside the text turned a cut JSON
    // document into one that fails to parse at the cap with no reason
    // given. The content is a clean prefix; truncated/total_chars tell the
    // reader what it holds.
    const cap = MAX_CHARS();
    const cut = content.length > cap;
    const out = {
      type: 'text', url,
      content: cut ? content.slice(0, cap) : content,
      audience: 'external',
      provenance: { source: 'web_fetch:' + url, tier: 'untrusted' },
    };
    if (cut) {
      out.truncated = true;
      out.total_chars = content.length;
      out.kept_chars = cap;
      out.note = 'the page is ' + content.length + ' characters; content holds the first ' + cap +
        (/^\s*[\[{]/.test(content) ? '. It is a JSON document, so this prefix does not parse: fetch a smaller resource or the specific fields you need.' : '.');
    }
    return out;
  }, ctx);
}

// ── web_search (CDP → search engine results page) ─────────────────────────
const searchSchema = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web in a real browser and return ranked {title, url, snippet} results. Use to research a topic, then web_fetch the most relevant results to read them. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        limit: { type: 'integer', description: 'Max results (1-10, default 6).', minimum: 1, maximum: 10 },
      },
      required: ['query'],
    },
  },
};

// Sovereign search = OUR own CDP browser driving automation-tolerant SERPs in a
// PRIORITISED FALLBACK CHAIN. No vendor, no key, no daemon to maintain. The chain
// + the headful requirement were MEASURED on a real Mac:
// Brave/Ecosia/Startpage all return Google-grade results headful (Brave returned a government
// portal plus reviews, news and docs domains); headless = every one blocks (CAPTCHA/403/CF).
// Order is by measured quality: Brave (own index, fast, best) → Ecosia
// (Google/Bing-backed) → Startpage (Google, slower) → Marginalia (indie last
// resort). If one is blocked/empty we fall to the next = resilience. Operator can
// override the whole chain with a single backend via TROTH_SEARCH_URL ({q}
// placeholder) — e.g. a self-hosted SearXNG. NO silent low-quality default: if
// every engine fails we return an honest error (usually means HEADLESS).
const ENGINE_CHAIN = [
  { name: 'brave',      url: 'https://search.brave.com/search?q={q}' },
  { name: 'ecosia',     url: 'https://www.ecosia.org/search?q={q}' },
  { name: 'startpage',  url: 'https://www.startpage.com/sp/search?query={q}' },
  { name: 'marginalia', url: 'https://marginalia-search.com/search?query={q}' },
];
// CAPTCHA / block / interstitial signatures — when present we skip to the next engine.
const BLOCK_RE = /captcha|unusual traffic|are you (a )?robot|verify (you|that you| your)|not a robot|access denied|forbidden|rate.?limit|too many requests|cf-?challenge|cloudflare|just a moment|startpage blocked/i;

// Generic external-result extraction (engine-agnostic) PLUS title+snippet so we
// can detect a block page. innerText excludes scripts/hidden nodes = sanitization.
function _searchExpr(limit) {
  return '(function(){var host=location.host;' +
    'var etok=(host.split(".").filter(function(p){return p.length>3&&p!=="search"&&p!=="www";})[0]||"");' +
    'var seen={};var out=[];var as=document.querySelectorAll(\'a[href^="http"]\');' +
    'for(var i=0;i<as.length;i++){var a=as[i];var href=a.href;var t=(a.innerText||"").trim();' +
    'try{var u=new URL(href);if(u.host===host||(etok&&u.host.indexOf(etok)>=0)||/\\.(css|js|png|svg|ico|woff2?)$/i.test(u.pathname))continue;}catch(e){continue;}' +
    'if(!t||t.length<4)continue;if(seen[href])continue;seen[href]=1;' +
    'out.push({title:t.slice(0,140),url:href});if(out.length>=' + limit + ')break;}' +
    'return JSON.stringify({title:document.title,snippet:(document.body?document.body.innerText:"").slice(0,300),results:out});})()';
}

async function runSearch(args, ctx) {
  args = args || {};
  const q = args.query || args.q;
  if (!q || typeof q !== 'string') return { error: 'bad_args', detail: 'query required' };
  const limit = Math.max(1, Math.min(12, parseInt(args.limit || 8, 10) || 8));
  const override = process.env.TROTH_SEARCH_URL;
  const chain = override
    ? [{ name: 'custom', url: override.indexOf('{q}') >= 0 ? override : override + '{q}' }]
    : ENGINE_CHAIN;
  const expr = _searchExpr(Math.max(limit, 8));
  return _withPage(async (s) => {
    const tried = [];
    for (const eng of chain) {
      if (_cancelAsked(ctx)) return _cancelled();
      const serp = eng.url.replace('{q}', encodeURIComponent(q));
      let data = {};
      try {
        const raw = await _navExtract(s, serp, expr, ctx);
        try { data = JSON.parse(raw || '{}'); } catch (_) { data = {}; }
      } catch (_) { tried.push(eng.name + ':error'); continue; }
      const results = (data.results || []).filter((r) => r && r.url && /^https?:\/\//i.test(r.url));
      if (BLOCK_RE.test((data.title || '') + ' ' + (data.snippet || ''))) { tried.push(eng.name + ':blocked'); continue; }
      if (results.length < 2) { tried.push(eng.name + ':empty'); continue; }
      return {
        type: 'text', query: q, engine: eng.name, backend: 'cdp:' + eng.name,
        tried: tried.concat(eng.name), results: results.slice(0, limit),
        audience: 'external', provenance: { source: 'web_search:' + eng.name, tier: 'untrusted' },
      };
    }
    return {
      error: 'all_engines_failed', query: q, tried,
      detail: 'Every sovereign SERP via the CDP browser was blocked/empty (' + tried.join(', ') + '). Most likely the browser is running HEADLESS — every mainstream SERP blocks headless CDP; the body must be HEADFUL (TROTH_BROWSER_HEADLESS=0). Or set TROTH_SEARCH_URL to a self-hosted SearXNG.',
    };
  }, ctx);
}

module.exports = {
  web_fetch:  { schema: fetchSchema,  run: runFetch },
  web_search: { schema: searchSchema, run: runSearch },
};
