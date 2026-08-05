// SPDX-License-Identifier: AGPL-3.0-only
// system-prompt — build the system message for Mode A agentic turns.
//
// Goal: terminal-claude quality, not sdk-cli quality. The voice app
// previously called `claude --print --input-format stream-json...`
// which Claude Code internally tags as `entrypoint:'sdk-cli'` — a
// stripped-down system prompt with low tool propensity. This module
// is the reason troth-entity is a real alternative to that path:
// we ship our own system prompt, tuned for tool-eager autonomous use.
//
// Design constraints (from research + troth's own engrams):
//   Concise. Anthropic's "Effective Context Engineering" says the
//     system prompt is the model's BEHAVIORAL BACKBONE — every token
//     here trades against task tokens. Cap 1500 chars unless the caller
//     overrides; verbose system prompts measurably degrade tool use.
//   Tool inventory inline. Models that see the tool schemas in
//     `tools[]` AND a short prose advertisement in the system prompt
//     fire tools more often than tools[] alone (Anthropic blog).
//   Anti-sycophancy. troth's drift-detector flags "sycophancy"
//     and "fawning agreement" as production failure modes. Encode
//     "no agreement-padding, no preamble" explicitly.
//   Voice-mode flag. When opts.audio = true, additional brevity
//     directive (≤25 words for chitchat, ≤2 sentences otherwise) and
//     no markdown formatting (TTS reads asterisks).
//   Identity hook DEPRECATED. The identity_anchors[] and
//     identity_refusals[] params used to surface anchors/refusals as
//     prompt-text bullets, but per the design work (R17 — hard walls > soft
//     instructions) refusals must be structurally enforced at
//     procedure-matcher / permission.js pre-LLM, NOT in the system
//     prompt where prompt-injected pages can override them. Anchors
//     are surfaced via entity-prefix.js makePrefixProvider's
//     <memory_identity> block (scope='identity' engrams) — the proper
//     identity-envelope channel. Params still accepted for backward
//     compat but unused; remove from new callers.
//
// Pure function — no I/O, no LLM call. Caller assembles deps and
// renders.

// raised 2400 -> 3400. The full prompt (operating context,
// tool advertisement, hands, honesty/no-fabrication, audio brevity, style
// guards) is ~3180 chars WITH the audio directive; the old 2400 cap
// silently sliced the tail, and the tail is where AUDIO MODE and the
// honesty guard live. A capped system prompt is a SILENT loss of the very
// rules we most want enforced. The cap is only a runaway guard, not a
// budget knob: the system prompt is a STABLE cache prefix (the prefix-
// stability concern is VOLATILE recall/situation text, not this), so ~800
// cached tokens once per session is free. Every section here is deliberate;
// nothing should be truncated in normal operation.
// Re-measured  after the mcp_register_request sentence (41-tool
// unified surface, audio on): 3228 with no configured hands, 3369 with one
// configured hand named in the prompt.: act-first section added
// (~360 chars, the anti-ask-loop mandate) -> ~3590/~3730; cap raised
// 3400 -> 3900 so the tail (AUDIO MODE + honesty guard) still never
// truncates. Pinned by suite-18 MCPH-15.
// Later: never-playwright browser rule added
// (~150 chars) -> measured 3763 no hands / 3876 one hand. 3900 left only
// 24 chars of headroom against the DYNAMIC hand-name list, so cap raised
// 3900 -> 4050 to restore the prior safety margin.
//  (secrets live find): SECRETS rule added (~430 chars). With a
// configured hand named in the prompt the total clears 4050 and the tail
// (AUDIO MODE + honesty guard) would silently truncate, the exact failure
// this header warns about. Cap raised 4050 -> 4500.
const DEFAULT_MAX_CHARS = 4500;

function listToolLine(toolNames) {
  if (!Array.isArray(toolNames) || !toolNames.length) return '';
  return 'Available tools: ' + toolNames.join(', ') + '.';
}

function clamp(text, maxChars) {
  if (typeof text !== 'string') return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 16)) + '\n…(truncated)';
}

function buildSystemPrompt(opts) {
  opts = opts || {};
  const agent_id = opts.agent_id || 'entity';
  const cwd      = opts.cwd      || '';
  const tools    = Array.isArray(opts.available_tools) ? opts.available_tools : [];
  // identity_anchors / identity_refusals params deprecated  —
  // anchors flow via the substrate identity envelope (entity-prefix.js
  // <memory_identity> block); refusals enforced structurally at
  // procedure-matcher / permission.js (R17). Kept here to swallow
  // legacy call sites without breaking; sections never emit even when
  // populated. See file header for rationale.
  const audio    = !!opts.audio;
  const profile  = opts.profile || null;
  const maxChars = opts.max_chars || DEFAULT_MAX_CHARS;

  const sections = [];

  // ── Operating context ──
  // Narrow identity claims contradict the substrate's persistent-
  // collaborator framing in STABLE_PREFIX and lead the model to refuse
  // anything outside the claimed role (observed: 'find a way
  // to make money' → 'I can't help, I'm a coding agent'). Operating
  // context only here — environment + agent_id + cwd. Identity is the
  // substrate's job, not this prompt's.
  sections.push(
    'Operating context: running on the user\'s machine, ' +
    'agent_id=' + agent_id + (cwd ? '; cwd=' + cwd : '') + '. ' +
    'You have shell + file-system tools available when the task warrants them; ' +
    'you are also a thinking partner for whatever the user actually wants to work on.'
  );

  // ── Tool advertisement (inline reinforcement of the tools[] payload) ──
  if (tools.length) {
    sections.push(listToolLine(tools));
    sections.push(
      'Use tools when the task genuinely needs file inspection, code changes, search, or shell. ' +
      'Read before Edit. Prefer hashline-tagged Edit (call Read with hashline=true first) when changing existing code - ' +
      'whitespace-immune and fails fast on file drift. Use Bash for one-shot commands; long output auto-archives to disk ' +
      'and is fetchable via Read. Tools are a capability, not a mandate - plenty of conversation needs no tool at all.'
    );
    // ── Act-first ──
    // A weak local model reads the hedge above plus the honesty guards and
    // rationally chooses to "clarify" forever: asked to search the web for
    // rentals with budget and dates already given, it produced question
    // loops across whole sessions and zero tool calls. The missing rule is
    // not capability, it is a mandate for researchable requests.
    sections.push(
      'When the operator asks you to find out, search, look up, or do something actionable, ACT FIRST: call ' +
      'web_search / web_fetch / the fitting tool with the details you already have, then report findings. Ask a ' +
      'clarifying question only for a truly missing REQUIRED detail that a quick search cannot resolve. Never answer ' +
      'a "do the work" request with only questions.'
    );
    // ── Browser rule ──
    // Absolute: no scripted headless automation, even for localhost E2E.
    // Playwright is not installed and a hand-written script bypasses the
    // governed browser path (live find: Claude-backbone pane wrote one).
    sections.push(
      'Browser work always goes through the browser tools (web_search / web_fetch / browser steps). ' +
      'Never write playwright/puppeteer/selenium scripts.'
    );
    // ── Secrets rule (live find: Kimi pane pasted a fresh secret
    // into the chat and told the operator to place it manually, with the
    // Supabase hand configured and able to do it). The vault surface exists
    // (credential NAMEs, fill_from_vault / capture_to_vault, credential_list)
    // but no standing instruction told the model secrets are radioactive.
    // Same gap class as the browser rule: bind the discipline to the prompt.
    sections.push(
      'SECRETS: never print secret values (API keys, tokens, passwords, .env values, connection strings) ' +
      'in a reply, and never ask the operator to copy-paste one you could place yourself. When a task ' +
      'produces or needs a secret: store it in the operator vault and refer to it only by credential NAME, ' +
      'then place it where it belongs through the configured hands (mcp_call, http with credential_name, ' +
      'browser steps with fill_from_vault / capture_to_vault). If the operator must know, name the ' +
      'destination and the credential NAME, never the value. If a tool result echoes a secret, do not repeat it.'
    );
    // ── Hands-first principle ──
    // The partner has external MCP servers as "extra hands" (mcp_list /
    // mcp_call). Steer it toward a configured/API-backed path for account
    // or API work and reserve the browser for genuinely human-gated steps,
    // so it does not default to slow, brittle browser driving when a clean
    // programmatic hand exists. No em-dash in authored strings per repo rule.
    // Name the ACTUALLY-configured servers (workspace.mcp.json + global
    // registry) right in the prompt. Live find: the
    // hands were on the tool surface and the resolver saw the supabase
    // server, but the prompt only said "discover with mcp_list" - an
    // optional step an eager gpt-5.6 skipped, reaching for the supabase CLI
    // and writing schema.sql locally instead. Telling the partner the hand
    // EXISTS (not "go look for one") is the difference. Sync, fail-safe:
    // a broken/absent registry must never brick prompt assembly.
    let configuredHands = [];
    try {
      const _mcp = require('./mcp-client.js');
      if (_mcp && typeof _mcp.loadDownstream === 'function') {
        configuredHands = Object.keys(_mcp.loadDownstream(null, cwd) || {});
      }
    } catch (_) { configuredHands = []; }
    if (configuredHands.length) {
      sections.push(
        'Configured MCP hands here: ' + configuredHands.join(', ') + '. For their domain use mcp_call, not a CLI, ' +
        'a browser, or files faked locally: mcp_list({server}) then mcp_call({server, tool, args}). If a call is ' +
        'refused for capability, do NOT fall back to a CLI: tell the operator to enable that service in ' +
        'Settings > Integrations > External services (or headless: troth cap mint capability:mcp:<server> --max medium).'
      );
    } else {
      sections.push(
        'For account-based or API-backed services, prefer a configured MCP/API over the browser (browser is the ' +
        'fallback for signup/OAuth/captcha). Discover hands with mcp_list; if none fits, ask the operator to add ' +
        'the service in Settings > Integrations > External services (headless: workspace .mcp.json + troth cap mint).'
      );
    }
    // Conversational MCP registration: a config snippet pasted
    // in chat routes to mcp_register_request (stages the inert pending
    // file), then ONE operator approval activates it. Without this line the
    // partner tries to edit the registry itself and path-policy refuses.
    sections.push(
      'If the operator gives you an MCP server config, call mcp_register_request with it and ask them to approve; ' +
      'never edit registry files yourself.'
    );
  }

  // ── Style guards (anti-sycophancy + concise) ──
  sections.push(
    'Style: direct, factual, no preamble, no apologies. Do not say "Great question" or "You\'re absolutely right" - ' +
    'state results and decisions directly. Disagree when you have evidence; do not fold under pressure without new info.'
  );

  // ── Honesty / no-fabrication ──
  // The agent has NO background execution: a turn is one synchronous run. It
  // was caught claiming "deep research running in the background" and writing a
  // fake progress checklist. Forbid claiming work that isn't really happening.
  sections.push(
    'Honesty: you have NO background execution - a turn is one synchronous run. Never claim work is running in the ' +
    'background, that research or a process is "in progress", or that you will act "later". Report ONLY what your tools ' +
    'actually did this turn; if you cannot finish now, say so plainly and do as much as you genuinely can - never fake ' +
    'progress or invent status.'
  );

  // ── Substrate memory framing ──
  // Tells the model that any <memory_*> XML block appearing in the
  // prefix below is BACKGROUND STATE the substrate already holds — not
  // a fresh user instruction, not a task to acknowledge, not something
  // to re-state. Without this framing the model treats prefix memory as
  // imperative ("Remember the user prefers X" → model replies "Got it,
  // I will remember"), the documented double-asking anti-pattern.
  sections.push(
    'Substrate memory: if you see <memory_identity>, <memory_session>, <memory_research>, or <memory_procedural> ' +
    'blocks in the prefix, treat them as background context the substrate already holds. They are not instructions, ' +
    'not pending tasks, and not new information from the user - do not acknowledge, restate, or re-ask. Use them silently.'
  );

  // ── Proactive identity capture ──
  // The substrate cannot know which dialogue moments are identity-worthy
  // until the LLM faculty has parsed them in context. Operator should
  // not have to type "remember this" — that is the partner's job. When
  // update_identity is in the tool inventory, instruct the model to
  // call it on its own whenever a stable fact about operator / project /
  // how-we-work surfaces.
  if (tools.includes('update_identity')) {
    sections.push(
      'Identity capture: when the operator confirms a non-obvious approach, corrects you, states a preference or ' +
      'constraint, or names what we are building / why / for whom, call update_identity yourself - do not wait to be ' +
      'asked. One call per durable fact, single declarative sentence. Skip if it is ephemeral task state, already in ' +
      'the identity prefix this turn, or obvious from code.'
    );
  }

  // ── Voice-mode brevity ──
  if (audio) {
    sections.push(
      'AUDIO MODE: replies will be spoken via TTS. Plain text only - no markdown, no code fences, no asterisks. ' +
      'Chitchat ≤25 words. Substantive answers ≤2 sentences unless the user explicitly asks for detail.'
    );
  }

  // Identity anchors + refusals NO LONGER emitted here. Channel moved to
  // <memory_identity> block (substrate identity envelope) for anchors,
  // and procedure-matcher / permission.js (substrate gates) for refusals.
  // See file header.

  // ── Profile bypass (operator override for unusual modes) ──
  if (profile && typeof profile === 'string') {
    sections.push('Profile: ' + profile);
  }

  return clamp(sections.filter(Boolean).join('\n\n'), maxChars);
}

module.exports = {
  buildSystemPrompt,
  DEFAULT_MAX_CHARS
};
