// SPDX-License-Identifier: AGPL-3.0-only
// LLM Orchestrator — C4 of Substrate-as-Entity v0.1.
//
// The substrate's language faculty driver. When the decision engine
// returns { kind: 'llm',... }, the runtime hands it here. This module:
//
//   1. Composes the call: stable identity prefix (cached) + per-call delta.
//   2. Streams tokens from the chosen provider.
//   3. Reads the stream incrementally so the substrate can evaluate
//      fragments mid-flight and cancel if the output goes off-track.
//   4. Returns the accumulated fragment OR aborts and lets the runtime
//      decide the next action.
//
// Provider-agnostic via injected `transport`. Transport contract:
//   stream({ system, user, options }) → AsyncIterable<{ delta?, done? }>
//   abort(streamHandle) — best-effort cancellation
//
// This module never imports a specific SDK. Tests pass fakes; production
// passes Anthropic / OpenAI / local-vLLM adapters. Same pattern as
// shared-core/identity.js (Layer B HTTP bridge) — keep dependencies out
// of the substrate core so plugin install stays lean.
//
// "Real-time" here means: substrate is reading the stream as tokens
// arrive, not waiting for completion. Cancellation is cheap. Multiple
// focused calls compose one user-facing response, not a single shot.

const DEFAULT_FRAGMENT_TIMEOUT_MS = 8000;

// parseTextToolCalls — some local/open models (e.g. Qwen) emit tool calls as
// TEXT inside the content instead of native JSON tool_calls. The provider passes
// that straight through, so without parsing it the tool NEVER runs (the model
// then loops "let me write the file…" until the loop-detector aborts) AND the raw
// markup leaks into the chat. We recognise two shapes and convert them to
// OpenAI-shape tool_calls so the normal executor handles them:
//   (a) <function=NAME><parameter=KEY>VALUE</parameter>…</function>  (often wrapped in <tool_call>…)
//   (b) <tool_call>{"name":"NAME","arguments":{…}}</tool_call>       (JSON-in-tags)
// Returns { toolCalls:[…], cleanedText } with the recognised markup stripped.
// Pure + deterministic → unit-testable with canned strings.
function parseTextToolCalls(text) {
  const src = String(text == null ? '' : text);
  const toolCalls = [];
  let n = 0;
  // QUOTED markup is documentation, not a call. Markup inside a
  // markdown code fence or inline backticks is something the model is SHOWING
  // the user — an example, a how-to — and executing it is the text-heuristic
  // false-positive family (same disease as the exit-0 staple). Two exceptions
  // stay live: a fence whose WHOLE body is the markup (several local models
  // wrap their real calls in a fence), and an UNCLOSED trailing fence that
  // starts with markup (a real call truncated mid-fence by the token ceiling).
  const segments = [];
  {
    const codeRe = /```[^\n]*\n[\s\S]*?```|```[^\n]*\n[\s\S]*$|`[^`\n]+`/g;
    let last = 0, cm;
    while ((cm = codeRe.exec(src)) !== null) {
      if (cm.index > last) segments.push({ quoted: false, text: src.slice(last, cm.index) });
      const block = cm[0];
      const fenced = block.startsWith('```');
      const closed = fenced && block.endsWith('```') && block.length > 6;
      const inner = fenced
        ? block.replace(/^```[^\n]*\n/, '').replace(/\n?```\s*$/, '')
        : null;
      const liveMarkup = inner != null && (
        (closed && /^\s*<(tool_call|function)\b[\s\S]*<\/(tool_call|function)\s*>\s*$/i.test(inner)) ||
        (!closed && /^\s*<(tool_call|function)\b/i.test(inner))
      );
      segments.push(liveMarkup ? { quoted: false, text: inner } : { quoted: true, text: block });
      last = cm.index + block.length;
    }
    if (last < src.length) segments.push({ quoted: false, text: src.slice(last) });
  }
  // (a) function blocks (with or without a <tool_call> wrapper) — the Qwen shape.
  for (const seg of segments) {
    if (seg.quoted) continue;
    const fnRe = /<function\s*=\s*["']?([A-Za-z0-9_.\-]+)["']?\s*>([\s\S]*?)<\/function>/gi;
    let m;
    while ((m = fnRe.exec(seg.text)) !== null) {
      const name = m[1];
      const body = m[2] || '';
      const args = {};
      const pRe = /<parameter\s*=\s*["']?([A-Za-z0-9_.\-]+)["']?\s*>([\s\S]*?)<\/parameter>/gi;
      let p;
      while ((p = pRe.exec(body)) !== null) args[p[1]] = p[2].trim();
      toolCalls.push({ id: 'ttc_' + (n++), type: 'function', function: { name, arguments: JSON.stringify(args) } });
    }
  }
  // (b) JSON-in-tags blocks — only when no function-form was found (mutually exclusive in practice).
  if (!toolCalls.length) {
    for (const seg of segments) {
      if (seg.quoted) continue;
      const tcRe = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi;
      let m;
      while ((m = tcRe.exec(seg.text)) !== null) {
        const jm = (m[1] || '').match(/\{[\s\S]*\}/);
        if (!jm) continue;
        try {
          const obj = JSON.parse(jm[0]);
          const name = obj.name || (obj.function && obj.function.name);
          if (!name) continue;
          let args = obj.arguments || obj.parameters || (obj.function && obj.function.arguments) || {};
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch (_) {} }
          toolCalls.push({ id: 'ttc_' + (n++), type: 'function', function: { name, arguments: JSON.stringify(args || {}) } });
        } catch (_) { /* malformed block — skip */ }
      }
    }
  }
  // Strip the recognised markup so it never leaks into the reply text —
  // quoted segments pass through untouched (the user asked to SEE them).
  const cleanedText = segments.map((seg, i) => {
    if (seg.quoted) return seg.text;
    let t = seg.text
      .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, '')
      .replace(/<function\s*=\s*[\s\S]*?<\/function>/gi, '');
    // Truncated/unclosed tool-call markup (model cut off mid-call by idle-
    // timeout or token ceiling) only exists at the true end of the message:
    // strip the dangling tail there so raw tags never leak or re-feed a loop.
    if (i === segments.length - 1) {
      t = t.replace(/<tool_call\b[\s\S]*$/i, '').replace(/<function\s*=[\s\S]*$/i, '');
    }
    return t;
  }).join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { toolCalls, cleanedText };
}

function makeOrchestrator(opts) {
  opts = opts || {};
  const transport = opts.transport;
  if (!transport || typeof transport.stream !== 'function') {
    throw new Error('llm-orchestrator: opts.transport.stream(req) is required');
  }
  const evaluator = typeof opts.evaluate === 'function' ? opts.evaluate : null;
  // Faculty name used to name the engine in honest-failure text when a
  // transport throws before it streams anything (pre-stream start failure).
  const facultyLabel = (opts.faculty_label != null) ? String(opts.faculty_label) : '';
  const stablePrefix = opts.stable_prefix || '';
  // prefix_provider is an optional per-call hook that returns a string
  // to APPEND to the static stable_prefix. Substrate uses it to surface
  // continuity context (recent dialogue turns, active goals, etc.) so
  // each call sees current state, not the boot-time snapshot.
  const prefixProvider = typeof opts.prefix_provider === 'function' ? opts.prefix_provider : null;
  // PREFIX-STABILITY: the provider's output is
  // VOLATILE (situation snapshot, recent dialogue, per-turn recall), and it
  // used to be appended into req.system. Chat templates render system FIRST,
  // then the ~9K tokens of tool schemas - so one changed byte near the top
  // invalidated the server's whole KV prefix and EVERY turn re-prefilled
  // ~10K tokens (40s per "hey" on a 31B Q8; measured: llama-server reuses
  // 4107/4114 tokens when the prefix IS stable). Now req.system carries ONLY
  // the static stable_prefix and the volatile context rides at the TOP of
  // the user message, which renders AFTER the tools in every template -
  // static system + static tools stay a byte-stable cached prefix across
  // turns. The in-process local warm session wins too: its reuse key is the
  // system prompt, which no longer changes per turn.
  // TROTH_PREFIX_IN_SYSTEM=1 restores the old layout (rollback hatch).
  const PREFIX_IN_SYSTEM = process.env.TROTH_PREFIX_IN_SYSTEM === '1';
  async function resolvePrefix(action, ctx) {
    if (!prefixProvider) return { system: stablePrefix, context: '' };
    let extra = '';
    try {
      const r = prefixProvider(action, ctx);
      // Support both sync and async providers — substrate may need
      // to query L1 / call /embedding before returning.
      extra = (r && typeof r.then === 'function') ? (await r) : r;
      if (extra == null) extra = '';
    } catch (_) { extra = ''; }
    if (!extra) return { system: stablePrefix, context: '' };
    if (PREFIX_IN_SYSTEM) {
      return {
        system: stablePrefix ? (stablePrefix + '\n\n' + String(extra)) : String(extra),
        context: ''
      };
    }
    return { system: stablePrefix, context: String(extra) };
  }
  // Optional notify hook fired right BEFORE each tool executes in the agentic
  // loop, so the surface can show "editing X / running Y" instead of a frozen
  // "Thinking" (the agentic loop ran tools silently — only the final text ever
  // reached the UI). The caller (troth-entity) maps it to a tool_request event.
  const onToolStart = typeof opts.onToolStart === 'function' ? opts.onToolStart : null;
  // Completion twin of onToolStart — fired when a visibility-only tool
  // (agent-faculty internal run, e.g. the claude harness's own Task agents)
  // reports done via {tool_activity_done}. Without it the surface chips had
  // a start and no end.
  const onToolEnd = typeof opts.onToolEnd === 'function' ? opts.onToolEnd : null;
  // Optional notify hook fired for EACH streamed text delta, so the surface can
  // show tokens flowing ("writing") instead of a frozen "Thinking" even on turns
  // that make zero tool calls. The caller (troth-entity) maps it to a text_delta
  // event the UI already consumes. Best-effort; never blocks the stream.
  const onTextDelta = typeof opts.onTextDelta === 'function' ? opts.onTextDelta : null;
  const timeout = opts.timeout_ms || DEFAULT_FRAGMENT_TIMEOUT_MS;
  // Absolute ceiling so a pathological never-ending stream can't run forever now
  // that the per-chunk timeout below is IDLE-based (resets on progress) instead
  // of an absolute wall-clock cap. 30 min mirrors the Rust entity idle cap.
  const hardCeilingMs = opts.hard_ceiling_ms || parseInt(process.env.TROTH_LLM_HARD_CEIL_MS || '1800000', 10) || 1800000;
  // Pull the next chunk but give up if NOTHING arrives for idleMs (a hung/stalled
  // stream). Returns the iterator result ({value,done}) on progress, or
  // {__idle:true} on a silent gap. This is what lets a long-but-STREAMING
  // generation run as long as it keeps producing tokens, while still bounding a
  // genuine hang — critical because the entity heartbeat keeps the Rust idle
  // timer alive regardless of stream state, so the orchestrator must self-bound.
  const pullWithIdle = async (iterator, idleMs) => {
    let timer;
    const nextP = Promise.resolve(iterator.next());
    nextP.catch(() => {});  // we may abandon this on idle — never let it throw unhandled
    const idleP = new Promise((resolve) => { timer = setTimeout(() => resolve({ __idle: true }), idleMs); });
    try { return await Promise.race([ nextP, idleP ]); }
    finally { clearTimeout(timer); }
  };
  // Substrate-derived decode-time constraints (grammar / logit_bias /
  // prefix cache). May be a static object or a function called per
  // request — the latter lets substrate state evolve and re-shape
  // decode behavior on each call. Transports that understand the
  // shape (currently llamacpp) honor it; others ignore it cleanly.
  const decodeConstraintsSrc = opts.decode_constraints || null;
  function resolveDecodeConstraints(action, ctx) {
    if (!decodeConstraintsSrc) return null;
    if (typeof decodeConstraintsSrc === 'function') {
      try { return decodeConstraintsSrc(action, ctx) || null; }
      catch (_) { return null; }
    }
    return decodeConstraintsSrc;
  }

  // Single-fragment call. Returns {ok, text, cancelled, reason}.
  async function callOnce(action, ctx) {
    const baseOptions = action.options || {};
    const constraints = resolveDecodeConstraints(action, ctx);
    const { system: systemPrefix, context: turnContext } = await resolvePrefix(action, ctx);
    // Volatile substrate context leads the user message (see resolvePrefix):
    // clearly fenced so the model separates situational context from the
    // operator's actual words.
    const userText = turnContext
      ? '<turn_context>\n' + turnContext + '\n</turn_context>\n\n' + (action.prompt || '')
      : (action.prompt || '');
    const req = {
      system: systemPrefix,
      user:   userText,
      options: constraints
        ? { ...baseOptions, substrate_decode_constraints: { ...(baseOptions.substrate_decode_constraints || {}), ...constraints } }
        : baseOptions
    };
    let text = '';
    let cancelled = false;
    let cancelReason = null;
    let stream;
    try {
      stream = await transport.stream(req);
    } catch (e) {
      return { ok: false, text: '', cancelled: false, reason: 'transport_error', error: String(e && e.message || e) };
    }

    // IDLE-based timeout (reset on every chunk), bounded by an absolute ceiling
    // see makeOrchestrator. A still-streaming long generation is NOT killed;
    // only a silent gap of `timeout` ms aborts it.
    const turnStart = Date.now();
    const iterator = stream[Symbol.asyncIterator] ? stream[Symbol.asyncIterator]() : stream;
    let servedBy = null;
    try {
      while (true) {
        const step = await pullWithIdle(iterator, timeout);
        if (step && step.__idle) {
          cancelled = true;
          cancelReason = 'timeout';
          maybeAbort(transport, stream);
          break;
        }
        if (step.done) break;
        const chunk = step.value;
        if (Date.now() - turnStart > hardCeilingMs) {
          cancelled = true;
          cancelReason = 'timeout';
          maybeAbort(transport, stream);
          break;
        }
        if (chunk && chunk.delta) { text += String(chunk.delta); if (onTextDelta) { try { onTextDelta(String(chunk.delta)); } catch (_) {} } }
        if (chunk && chunk.served_by) servedBy = chunk.served_by;
        if (evaluator) {
          let verdict = null;
          try { verdict = evaluator(text, action, ctx); } catch (_) { verdict = null; }
          if (verdict && verdict.cancel) {
            cancelled = true;
            cancelReason = verdict.reason || 'evaluator_cancelled';
            maybeAbort(transport, stream);
            break;
          }
        }
        if (chunk && chunk.done) break;
      }
    } catch (e) {
      return { ok: false, text, cancelled: true, reason: 'stream_error', error: String(e && e.message || e) };
    }
    return { ok: !cancelled, text, cancelled, reason: cancelReason, served_by: servedBy };
  }

  // Tight orchestration loop: substrate may want several focused fragments
  // composed into one user response. Each fragment is a separate stream
  // so we can evaluate-and-cancel cleanly. Default cap from action.options
  // prevents unbounded looping.
  async function compose(action, ctx) {
    const cap = (action.options && action.options.max_fragments) || 1;
    const fragments = [];
    let aborted = false;
    let abortReason = null;
    let servedBy = null;
    for (let i = 0; i < cap; i++) {
      const stepAction = {
        ...action,
        prompt: i === 0 ? action.prompt : continuationPrompt(action, fragments)
      };
      const res = await callOnce(stepAction, { ...ctx, fragment_index: i });
      if (res.served_by) servedBy = res.served_by;
      if (res.text) fragments.push(res.text);
      if (!res.ok && res.cancelled) {
        aborted = true;
        abortReason = res.reason;
        break;
      }
      if (!res.ok) {
        aborted = true;
        abortReason = res.reason || 'fragment_failed';
        break;
      }
      // Heuristic: if the fragment looks complete (ends in sentence-ending
      // punctuation and is non-trivially long), stop early instead of
      // burning the budget.
      if (looksComplete(res.text) && i + 1 < cap) break;
    }
    return {
      status: aborted ? 'aborted' : 'ok',
      reason: abortReason,
      text: fragments.join(''),
      fragments,
      served_by: servedBy
    };
  }

  // Agentic tool loop. Substrate exposes a tool surface; the model
  // may call those tools mid-generation; the orchestrator dispatches
  // each call against a substrate-supplied `tool_runner`, appends
  // the result back into the conversation, and reissues the request.
  // Loops until the model returns a text-only turn or `max_iterations`
  // is exhausted.
  //
  // The tool_runner contract:
  //   tool_runner(toolCall, ctx) → Promise<string>
  // where toolCall is {id, function:{name, arguments}} and the
  // returned string becomes the `content` of a `role:'tool'` message
  // appended to the conversation.
  async function composeAgentic(action, ctx) {
    const tool_runner = (ctx && ctx.tool_runner) || opts.tool_runner;
    if (typeof tool_runner !== 'function') {
      throw new Error('llm-orchestrator.composeAgentic: ctx.tool_runner (or opts.tool_runner) is required');
    }
    // Per-turn cancel. The host passes
    // ctx.cancel_signal = {cancelled, reason, _abort}. Flipping `cancelled`
    // ends THIS turn as status:'aborted' at the next check point; `_abort`
    // is set by us to the active stream's transport abort so a cancel can
    // also unblock a turn that is mid-stream. Absent signal = no new paths.
    const cancelSignal = (ctx && ctx.cancel_signal) || null;
    const cancelHit = () => !!(cancelSignal && cancelSignal.cancelled);
    const cancelReason = () => (cancelSignal && cancelSignal.reason) || 'operator_cancel';
    const baseOptions = action.options || {};
    const constraints = resolveDecodeConstraints(action, ctx);
    const { system: substratePrefix, context: turnContext } = await resolvePrefix(action, ctx);
    // Mode A wiring: callers pass agentic-mode behavioral directives
    // (tool advertisement, style guards, audio brevity) via
    // action.options.system_extra. We concatenate AFTER the substrate
    // prefix so identity/anchors stay primary; the appended block
    // strictly adds operating instructions. Either may be empty. Both are
    // turn-stable, so the system message stays a cacheable prefix; the
    // VOLATILE substrate context rides in the user message instead (see
    // resolvePrefix - prefix-stability fix.
    const systemExtra = baseOptions.system_extra ? String(baseOptions.system_extra) : '';
    const systemPrefix = [substratePrefix, systemExtra].filter(Boolean).join('\n\n');
    // Default tool-call budget per agentic turn. Was 4 — far too low: chat turns
    // pass no override, so a multi-step task ("search X and do Y", "fix 3 files")
    // hit the cap after 4 tool round-trips and returned "Done."/"(Stopped)" mid-
    // task — the operator's "told it to search, it said DONE and did nothing".
    // Claude Code runs dozens. This is a SAFETY BACKSTOP, not a per-turn cost: the
    // loop already exits the instant the model stops emitting tool_calls (most
    // chat turns finish in 1-3), and the per-call timeout (240s) bounds wall-clock.
    // Callers (autonomous step-engine) still override with their own per-step cap.
    // No arithmetic cliff on real work. Claude CLI
    // parity: a turn runs until the MODEL finishes; the brakes on pathology
    // are the loop detector, the stagnant-repeat dedup, transport timeouts
    // and the context window — not a round number. A 140-call live task
    // died at the old 50 cap mid-work. Callers that WANT a bounded sub-turn
    // (step-engine passes 4, reflection passes 1) still get exactly what
    // they ask for; the default is a fuse so high it only blows on a
    // mathematically infinite loop that slipped every detector.
    const max_iterations = (action.options && action.options.max_iterations) || 1000;
    // faculty workstream — "intents, not tools" (standard S2). When on, the LLM emits
    // <intent> tokens in TEXT and the substrate parses them via
    // faculty.commitParsedIntents (through writeIntent's STVC wall) instead of
    // executing native tool_calls. The advertised tool array has already
    // excised action tools (substrate-tools.toolsArray / runner). Default OFF:
    // the native tool-call path below is byte-identical when the flag is unset.
    const facultyEmitMode = require('./substrate-tools.js').facultyEmitModeOn();

    const messages = [];
    if (systemPrefix) messages.push({ role: 'system', content: systemPrefix });
    messages.push({
      role: 'user',
      content: turnContext
        ? '<turn_context>\n' + turnContext + '\n</turn_context>\n\n' + String(action.prompt || '')
        : String(action.prompt || '')
    });

    // Empirical-baseline probe. Gated by TROTH_DEBUG_PREFIX=1 so it
    // never runs in production. When on, dumps the assembled messages
    // array to /tmp/gc-prefix.log on every turn so we can SEE what's
    // actually going to the LLM before refactoring the prefix provider.
    if (process.env.TROTH_DEBUG_PREFIX === '1') {
      try {
        const fs = require('fs');
        const summary = messages.map((m) => ({
          role: m.role,
          chars: typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length,
          preview: typeof m.content === 'string'
            ? m.content
            : JSON.stringify(m.content)
        }));
        const payload = {
          ts: new Date().toISOString(),
          total_chars: summary.reduce((n, s) => n + s.chars, 0),
          messages: summary
        };
        fs.appendFileSync('/tmp/gc-prefix.log',
          '\n\n=== TURN ' + payload.ts + ' (total ' + payload.total_chars + ' chars) ===\n' +
          JSON.stringify(payload, null, 2) + '\n');
      } catch (_) { /* never break the LLM call on debug failure */ }
    }

    const trace = [];
    let finalText = '';
    let toolCallsMade = false;
    let forcedAnswer = false;
    let aborted = false;
    let abortReason = null;
    // Guarantee a non-empty reply when the partner actually DID something.
    // Codex/reasoning models sometimes make a tool call and then return no
    // closing text (or the loop hits iteration_cap mid-action) — the surface
    // then showed "(no response)" even though files were written. If we acted
    // but have no text, say so instead of going silent.
    const finalize = () => {
      if (finalText && finalText.trim()) return finalText;
      if (toolCallsMade) return 'Done.';
      return finalText;
    };
    // Truncation honesty: every transport
    // faithfully reports finish_reason='length'/'content_filter' when the model
    // is cut at its token ceiling, but the orchestrator only pushed it to the
    // trace — so a reply that stops mid-sentence shipped as a confident, whole
    // answer. This holds the LAST turn's finish reason so the return path can
    // say the answer was cut. Set from the completed turn below.
    let lastTurnFinish = null;
    const TRUNCATING_FINISH = new Set(['length', 'max_tokens', 'model_length', 'content_filter']);
    // Staple unresolved action failures AND a truncation note to whatever text
    // we return. One wrapper so every return site is honest by construction.
    const withFailureNote = (text) => {
      let out = String(text || '').trim();
      if (toolFailures.size) {
        const lines = Array.from(toolFailures.values())
          .map((f) => '  - ' + f.name + ': ' + f.reason);
        out += '\n\n---\n[' + toolFailures.size + ' action(s) did NOT complete this turn. ' +
          'Anything above that claims they succeeded is not reliable:\n' +
          lines.join('\n') + ']';
      }
      if (lastTurnFinish && TRUNCATING_FINISH.has(lastTurnFinish)) {
        out += lastTurnFinish === 'content_filter'
          ? '\n\n---\n[The provider\'s content filter cut this answer short; it is incomplete.]'
          : '\n\n---\n[Answer was cut off at the model\'s length limit (' + lastTurnFinish +
            '); it is incomplete. Say "continue" to get the rest.]';
      }
      return out;
    };
    // L4 loop-detector wiring. The orchestrator
    // doesn't write action_records itself (caller does), so substrate-
    // chain detection can't fire here. We use the in-memory mode which
    // scans transitions accumulated across THIS composeAgentic run only.
    // Catches the canonical "A→B→A→B" within one turn — by far the most
    // common loop failure pattern (Devin/AutoGPT/OpenHands all hit it).
    // Cross-run loop detection (rare, requires substrate writes per
    // dispatch) is a v2 enhancement; see the design for the substrate
    // hook point when coordinator.js (L4 step 11) lands.
    const loopDetector = require('./loop-detector.js');
    const loopTransitions = [];
    let loopPriorDetections = 0;
    // Per-turn side-effect dedup: the loop detector
    // ABORTS a stuck turn, but by the time it trips, a repeating model has
    // already executed the identical command several times: ~10 browser
    // windows / duplicate folders opened before the abort landed, and every
    // "continue" reset the count. Refuse the 3rd+ IDENTICAL side-effecting
    // call outright: the model gets a structured refusal it can read and
    // change course on, and the OS-level damage is zero. Reads stay exempt
    // (idempotent); the detector remains the backstop for everything else.
    // What counts as an ACTION (deduped + failure-stapled) is defined by
    // EXCLUSION, not a hand-maintained allowlist. The old allowlist named 8
    // tools, so ~15 real side-effecting tools (image_generate, supabase_run_sql,
    // github_create_issue, browser_session, submit_goal, operator_request,
    // engram_record,...) could fail and the model could still say "Done." with
    // NO staple (exhaustive-sweep find,: the operator's false-Done
    // complaint was never Bash-only). A NEW side-effecting tool added later must
    // be caught by DEFAULT, so we track everything EXCEPT pure local discovery
    // reads whose failure is normal exploration and whose repeat is harmless.
    // Classified against the FULL unifiedRegistry surface (39 tools,
    //  adversarial re-review of this very change): a failed read
    // is normal exploration, and for the POLLING reads (sms_recent,
    // email_wait_for) identical repeats are the tool's NATURE — the first
    // cut of this set was 15 names and would have refused the 3rd SMS poll
    // while the partner waited for a login code.
    const NON_ACTION_READS = new Set([
      'Read', 'read', 'Grep', 'grep', 'Glob', 'glob', 'LS', 'ls', 'NotebookRead',
      'mcp_list', 'mcp_describe',
      'engram_search', 'recall', 'dialogue_recent', 'dialogue_search',
      'chameleon_query', 'chameleon_list_scopes',
      'jobs_status', 'credential_list', 'api_services_list', 'web_allowlist_list',
      'github_get_repo', 'vercel_list_projects', 'notion_search',
      'email_search', 'email_open', 'email_wait_for',
      'sms_recent', 'totp_code'
    ]);
    // An action is anything that is not a pure discovery read. web_search /
    // web_fetch ARE actions here on purpose: a failed fetch the model narrates
    // as "researched" is exactly a LARP, and a stagnant repeat wastes a round.
    const isActionTool = (name) => !!name && !NON_ACTION_READS.has(name);
    // Back-compat alias for the two remaining.has call sites below.
    const SIDE_EFFECT_DEDUP = { has: isActionTool };
    // Write and Edit mutate the same resource kind: success of one on a file
    // completes what a failed attempt of the other was trying to do there.
    const FILE_MUTATORS = new Set(['Write', 'Edit', 'write_file', 'edit_file']);
    const sideEffectCounts = new Map();
    // Per identical-call key: {hash, streak} of the last EXECUTED result —
    // how many consecutive runs of this exact call returned the same thing.
    const sideEffectLast = new Map();
    // Anti-LARP: a cloud model wrote a local
    // schema.sql, got 'unknown downstream server: supabase' from the real
    // action, then told the operator the task was DONE. The model lying about
    // completion is a known-hard problem, but we CAN make the lie impossible
    // to hide: track every side-effecting action whose LAST outcome was an
    // error and staple the list to the final answer, so 'done' is contradicted
    // by the record. Keyed by call signature: an identical retry that SUCCEEDS
    // clears the prior failure (no false alarm on recovered transients).
    const toolFailures = new Map();
    // Last provider/model that actually served a call this turn — the
    // final one is what wrote the answer the user reads.
    let servedBy = null;

    // Token accounting across ALL iterations of this turn — attached to
    // the final result so surfaces can show real counts (never estimated).
    const _usage = { in: 0, out: 0, seen: false, ctx: 0, win: 0 };
    // in/out SUM across iterations (billing truth); ctx/win take the LAST
    // call's values — context is a live state, not a running total: after
    // three agentic rounds the window holds the third prompt, not the sum of
    // all three. Zero means the transport never said (API lanes without the
    // fields), and the shape below omits what it does not know.
    const _usageOut = () => {
      if (!_usage.seen) return undefined;
      const u = { input_tokens: _usage.in, output_tokens: _usage.out };
      if (_usage.ctx > 0) u.context_used = _usage.ctx;
      if (_usage.win > 0) u.context_window = _usage.win;
      return u;
    };
    for (let iter = 0; iter < max_iterations; iter++) {
      // Cancel between LLM calls / tool rounds - the cheap check point.
      if (cancelHit()) { aborted = true; abortReason = cancelReason(); break; }
      // Base per-iteration options. Always a fresh spread so first-turn tool
      // forcing (below) never mutates baseOptions across iterations.
      const reqOptions = constraints
        ? { ...baseOptions, substrate_decode_constraints: { ...(baseOptions.substrate_decode_constraints || {}), ...constraints } }
        : { ...baseOptions };
      // First-turn tool forcing — anti-LARP for small local faculties. A weak
      // local model narrates ("I created the file") instead of emitting the
      // tool call. When the caller (autonomous step-engine action step) sets
      // first_turn_tool_choice AND tools are advertised, force a real tool call
      // on iter 0 ONLY; every later turn reverts to 'auto' so the model can read
      // the tool result and finalize (a blunt always-'required' never lets a
      // step terminate). Only the llamacpp/local transport honors
      // req.options.tool_choice — claude_cli runs its own tools, router/
      // anthropic/ollama/codex don't forward it — so this is inherently scoped
      // to the weak-local faculty where the LARP actually happens.
      if (baseOptions.first_turn_tool_choice && Array.isArray(reqOptions.tools) && reqOptions.tools.length) {
        reqOptions.tool_choice = (iter === 0) ? baseOptions.first_turn_tool_choice : 'auto';
      }
      const req = { messages, options: reqOptions };
      // Resilience: a single transient transport hiccup (a 5xx, a dropped SSE, a
      // refused connection) used to abort the ENTIRE turn mid-task. Retry the SAME request a bounded number of times before
      // giving up. Only retried when NOTHING has been committed yet (no streamed
      // text / tool call), so a retry can't duplicate output or double-bill a
      // partial response. NEVER retried: timeout / loop_detected / iteration_cap /
      // a CLI deterministic exit — those aren't transient.
      const MAX_TRANSIENT_RETRIES = parseInt(process.env.TROTH_LLM_TRANSIENT_RETRIES || '2', 10) || 0;
      const isTransient = (r) => /^(http_error|stream_error|request_error|router_error|http_status|http_5\d\d|http_429|ECONNRESET|ETIMEDOUT|socket)/i.test(String(r || ''));
      let turnText = '';
      let pendingToolCalls = null;
      let finishReason = null;
      let fatalReturn = null;
      // `stream` MUST live in the iteration scope, not inside the attempt loop:
      // the loop-detector abort paths further down run AFTER this attempt loop
      // closes and still call maybeAbort(transport, stream). Declaring it inside
      // the loop left those references out of scope → "ReferenceError: stream is
      // not defined" → the turn threw, processOne swallowed it to the substrate
      // with no emit, and the Rust watchdog reported a 1800s "stall". Keep hoisted.
      let stream = null;
      for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
        turnText = ''; pendingToolCalls = null; finishReason = null;
        let retryThis = false;
        try { stream = await transport.stream(req); }
        catch (e) {
          if (attempt < MAX_TRANSIENT_RETRIES) { await new Promise((r) => setTimeout(r, 250 * (attempt + 1))); continue; }
          // Pre-stream START failure (no key, bad config, unwired module): the
          // transport threw before a single chunk, so finalText is empty. An
          // empty-text aborted turn is a SILENT dead panel (studio p10 phase-C,
          //). Synthesize an honest, sanitized line naming the engine
          // so the operator sees a reason. Keep any real partial text if present.
          fatalReturn = {
            status: 'aborted', reason: 'transport_error',
            text: (finalText && finalText.trim()) ? finalText : _honestStartFailure(facultyLabel, e),
            trace, error: String(e && e.message || e)
          };
          break;
        }
        // Arm the per-turn cancel handle on the LIVE stream so a Stop can
        // unblock a turn that is sleeping/awaiting inside the transport
        // (the post-pull check below then converts the wake into the abort).
        if (cancelSignal) cancelSignal._abort = () => maybeAbort(transport, stream);
        // IDLE-based timeout (reset on every chunk), bounded by an absolute hard
        // ceiling — see makeOrchestrator. A long-but-STREAMING generation runs as
        // long as it keeps producing chunks; the old absolute deadline killed
        // exactly that case after 240s. A silent
        // gap of `timeout` ms still aborts a genuinely hung stream.
        const turnStart = Date.now();
        const iterator = stream[Symbol.asyncIterator] ? stream[Symbol.asyncIterator]() : stream;
        try {
          while (true) {
            const step = await pullWithIdle(iterator, timeout);
            // Cancel wins over whatever the pull returned: a Stop that woke
            // the stream via _abort must land as operator_cancel, not as a
            // transport abort/idle shape.
            if (cancelHit()) {
              aborted = true; abortReason = cancelReason();
              maybeAbort(transport, stream);
              break;
            }
            if (step && step.__idle) {
              aborted = true; abortReason = 'timeout';
              maybeAbort(transport, stream);
              break;
            }
            if (step.done) break;
            const chunk = step.value;
            if (Date.now() - turnStart > hardCeilingMs) {
              aborted = true; abortReason = 'timeout_hard_ceiling';
              maybeAbort(transport, stream);
              break;
            }
            // Transport-level failure (DNS/connection/http/stream error). If it's
            // transient AND nothing was committed yet AND we have retries left,
            // re-issue the SAME request; otherwise surface it as an ABORT.
            if (chunk && chunk._abort_reason) {
              if (isTransient(chunk._abort_reason) && !turnText && !pendingToolCalls && attempt < MAX_TRANSIENT_RETRIES) {
                retryThis = true; maybeAbort(transport, stream); break;
              }
              aborted = true;
              abortReason = 'transport_' + chunk._abort_reason;
              break;
            }
            // Visibility-only tool signal — e.g. an agent-faculty (claude_cli)
            // surfacing its OWN internal tool use. Fire the UI hook so a chip
            // shows, but do NOT add to pendingToolCalls: composeAgentic must not
            // re-execute a tool the sub-agent already ran.
            if (chunk && chunk.tool_activity) {
              if (onToolStart) {
                try { onToolStart({ id: chunk.tool_activity.id || '', function: { name: chunk.tool_activity.name || '', arguments: JSON.stringify(chunk.tool_activity.input || {}) } }); } catch (_) {}
              }
              // The agent-faculty's INTERNAL tool calls were invisible to the
              // loop detector (transitions were only pushed for orchestrator-
              // executed tool_calls), so a repetitive harness turn had NO loop
              // protection at all: the backbone opened
              // the same folder 3 times and ~20 identical browser windows with
              // nothing counting. Feed the SAME progress-aware detector from
              // the activity signal. No result content exists at this level
              // (the sub-agent runs its own tools), so the signature is
              // name+input: a stuck harness repeats identical inputs, while an
              // editing session's varying inputs keep the tail diverse
              // (tail-dominance semantics, LP-1/LP-3).
              const _act = chunk.tool_activity;
              const _actArgs = JSON.stringify(_act.input || {});
              const _actIn = _act.input || {};
              const _actTarget = _actIn.path || _actIn.file_path || _actIn.url ||
                                 _actIn.command || _actIn.query || _actIn.target || '';
              const _actHash = require('crypto').createHash('sha1')
                .update(_actArgs).digest('hex').slice(0, 12);
              loopTransitions.push({
                step_name:       'agentic_loop',
                tool_invoked:    _act.name || 'unknown',
                target_resource: String(_actTarget).slice(0, 200) + '#' + _actHash
              });
              const actDetection = loopDetector.detectInMemory({
                transitions:     loopTransitions,
                priorDetections: loopPriorDetections
              });
              if (actDetection.detected) {
                loopPriorDetections++;
                trace.push({ iter, loop_detection: actDetection });
                if (actDetection.action === 'abort') {
                  aborted = true;
                  abortReason = 'loop_detected';
                  maybeAbort(transport, stream);
                  break;
                }
              }
            }
            // Completion of a visibility-only tool (see tool_activity above).
            if (chunk && chunk.tool_activity_done && onToolEnd) {
              try { onToolEnd({ id: chunk.tool_activity_done.id || '' }); } catch (_) {}
            }
            if (chunk && chunk.delta) {
              turnText += String(chunk.delta);
              if (onTextDelta) {
                // Live-stream side of the secret wall: per-chunk redaction (a
                // secret split exactly across two chunks can transit the live
                // stream; the FINAL text below is always fully redacted).
                try { onTextDelta(require('./secret-redactor.js').redact(String(chunk.delta))); } catch (_) {}
              }
            }
            if (chunk && chunk.usage) {
              _usage.seen = true;
              _usage.in  += Math.max(0, chunk.usage.input_tokens  || 0);
              _usage.out += Math.max(0, chunk.usage.output_tokens || 0);
              if (Number(chunk.usage.context_used)   > 0) _usage.ctx = Number(chunk.usage.context_used);
              if (Number(chunk.usage.context_window) > 0) _usage.win = Number(chunk.usage.context_window);
            }
            if (chunk && Array.isArray(chunk.tool_calls)) pendingToolCalls = chunk.tool_calls;
            if (chunk && chunk.finish_reason) finishReason = chunk.finish_reason;
            if (chunk && chunk.served_by) servedBy = chunk.served_by;
            if (chunk && chunk.done) {
              // Safety net: a {done, error} WITHOUT _abort_reason (a transport
              // that didn't tag its failure) must not fall through to the
              // status:'ok' return below as an empty success. Abort honestly so
              // the entity's cross-faculty walk can rescue the turn.
              if (chunk.error && !chunk._abort_reason) {
                aborted = true;
                abortReason = 'transport_done_error';
              }
              break;
            }
          }
        } catch (e) {
          if (attempt < MAX_TRANSIENT_RETRIES && !turnText && !pendingToolCalls) {
            maybeAbort(transport, stream);
            await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
            continue;
          }
          // transport_ prefix — an iterator that THREW is a transport failure,
          // same as a transport-pushed stream_error chunk (which gets prefixed
          // at the _abort_reason branch above). Unprefixed, this shape was
          // ineligible for the entity's cross-faculty fallback walk.
          fatalReturn = { status: 'aborted', reason: 'transport_stream_error', text: finalText + turnText, trace, error: String(e && e.message || e) };
          break;
        }
        if (retryThis) { await new Promise((r) => setTimeout(r, 250 * (attempt + 1))); continue; }
        break; // success, or a non-transient abort — stop retrying
      }
      if (fatalReturn) return fatalReturn;
      if (aborted) break;

      // Text-format tool-call rescue: local/open models (e.g. Qwen) emit calls as
      // markup in the content rather than native JSON tool_calls. When the turn has
      // NO native tool_calls but the text carries that shape, parse it into
      // OpenAI-shape tool_calls and strip it from the spoken text — so the executor
      // below runs them (instead of the model looping on un-run "writes") and the
      // raw markup never leaks into the reply.
      if ((!pendingToolCalls || !pendingToolCalls.length) && turnText && /<(tool_call|function)\b/i.test(turnText)) {
        const _ttc = parseTextToolCalls(turnText);
        if (_ttc.toolCalls.length) {
          pendingToolCalls = _ttc.toolCalls;
          turnText = _ttc.cleanedText;
          trace.push({ iter, text_tool_calls: _ttc.toolCalls.length });
        } else if (_ttc.cleanedText !== turnText) {
          // Truncated/unclosed tool-call markup with no recoverable call — strip it
          // so the raw tags never leak into the reply or re-feed a repeat loop.
          turnText = _ttc.cleanedText;
          trace.push({ iter, stripped_truncated_tool_markup: true });
        }
      }

      if (turnText) finalText += turnText;
      trace.push({ iter, text: turnText, tool_calls: pendingToolCalls && pendingToolCalls.length, finish_reason: finishReason });
      // Remember THIS turn's finish reason for the truncation note. A turn that
      // is cut at 'length' but still emits tool_calls continues the loop, so a
      // later clean turn overwrites this and no false truncation note fires;
      // only a genuinely truncated FINAL turn keeps a truncating value here.
      lastTurnFinish = finishReason;

      // faculty workstream emit-mode: the substrate — not a tool the LLM holds —
      // parses <intent> tokens from the spoken text and routes them through
      // writeIntent's STVC wall. Native tool_calls are ignored in this mode.
      if (facultyEmitMode) {
        // Emit-mode parsing lives in the closed extension (guarded optional
        // require). Absent extension → a spoken-only turn.
        let _emitExt = null;
        try { _emitExt = require('./core-ext.js'); } catch (_) {}
        if (!_emitExt || typeof _emitExt.commitParsedIntents !== 'function') {
          return { status: 'ok', reason: null, text: withFailureNote(finalize()), trace, served_by: servedBy, usage: _usageOut() };
        }
        let parsed;
        try { parsed = _emitExt.commitParsedIntents(turnText, ctx); }
        catch (e) { parsed = { committed: [], refused: [], parse_errors: [String(e && e.message || e)] }; }
        const committed = parsed.committed || [];
        const refused = parsed.refused || [];
        const parseErrors = parsed.parse_errors || [];
        const hadIntents = committed.length + refused.length + parseErrors.length > 0;
        trace.push({ iter, faculty_emit: { committed: committed.length, refused: refused.length, parse_errors: parseErrors.length } });
        // No <intent> in the text → a spoken-only turn → the response is done.
        if (!hadIntents) return { status: 'ok', reason: null, text: withFailureNote(finalize()), trace, served_by: servedBy, usage: _usageOut() };
        // Feed the commit/refusal verdicts back so the model reasons about the
        // outcomes next iteration (dispatch + observation happen async via the
        // entity daemon; the verdict is the immediate signal).
        messages.push({ role: 'assistant', content: turnText });
        messages.push({ role: 'user', content: 'SUBSTRATE: ' + JSON.stringify({ committed, refused, parse_errors: parseErrors }) });
        for (const c of committed.concat(refused)) {
          loopTransitions.push({ step_name: 'agentic_loop', tool_invoked: 'intent:' + (c.scope || 'unknown'), target_resource: '' });
        }
        const detection = loopDetector.detectInMemory({ transitions: loopTransitions, priorDetections: loopPriorDetections });
        if (detection.detected) {
          loopPriorDetections++;
          trace.push({ iter, loop_detection: detection });
          if (detection.action === 'abort') { aborted = true; abortReason = 'loop_detected'; maybeAbort(transport, stream); break; }
        }
        continue;
      }

      if (pendingToolCalls && pendingToolCalls.length) {
        toolCallsMade = true;
        // Stamp deterministic ids on tool_calls that arrived without
        // one (llama-server's streaming sometimes omits id) — both the
        // assistant message AND the corresponding tool messages must
        // share the same id, or the model loses track of which result
        // pairs with which call.
        for (let i = 0; i < pendingToolCalls.length; i++) {
          const tc = pendingToolCalls[i];
          if (!tc.id) tc.id = 'tc_' + iter + '_' + i;
          if (!tc.type) tc.type = 'function';
        }
        // Append the assistant message with the tool_calls. Some
        // providers reject empty-string content alongside tool_calls;
        // null is the canonical "no spoken text, just calls" form.
        messages.push({
          role: 'assistant',
          content: turnText ? turnText : null,
          tool_calls: pendingToolCalls
        });
        for (const tc of pendingToolCalls) {
          // Cancel between tool executions: already-run tools stand (their
          // effects are real); the remaining calls in this batch are skipped
          // and the turn aborts right after the loop.
          if (cancelHit()) break;
          // Surface the tool BEFORE running it so the UI shows what's happening
          // (not a frozen "Thinking"). Best-effort; never blocks execution.
          if (onToolStart) { try { onToolStart(tc); } catch (_) {} }
          let resultStr = '';
          const _tcName = (tc.function && tc.function.name) || '';
          const _tcKey = _tcName + '#' + require('crypto').createHash('sha1')
            .update(String((tc.function && tc.function.arguments) || '')).digest('hex').slice(0, 12);
          const _tcSeen = (sideEffectCounts.get(_tcKey) || 0) + 1;
          sideEffectCounts.set(_tcKey, _tcSeen);
          // A repeat is only POINTLESS when the world stopped changing: the
          // previous identical calls kept returning the IDENTICAL result. A
          // 3rd `git status` or `npm test` after real edits returns something
          // NEW and is normal verification work, not a loop (args-only dedup
          // was refusing legitimate re-checks in long turns.
          // `open <same url>` keeps returning the same result, so the
          // 20-browser-windows case stays refused.
          const _stag = sideEffectLast.get(_tcKey);
          let _tcRefused = false;
          if (_tcSeen > 2 && SIDE_EFFECT_DEDUP.has(_tcName) && _stag && _stag.streak >= 2) {
            _tcRefused = true;
            resultStr = JSON.stringify({
              refused: 'identical_call_repeated',
              detail: 'This exact ' + _tcName + ' call already ran ' + _stag.streak +
                ' times this turn and returned the identical result each time. Running it ' +
                'again will not change the outcome. Change the arguments, take a different ' +
                'approach, or answer with what you have.'
            });
          } else {
          try { resultStr = await tool_runner(tc, ctx); }
          catch (e) { resultStr = JSON.stringify({ error: 'tool_runner_threw', detail: String(e && e.message || e) }); }
          }
          let resultContent = typeof resultStr === 'string' ? resultStr : JSON.stringify(resultStr);
          // STRUCTURAL secret wall (R17): remember secret-shaped literals from
          // every tool result BEFORE truncation, so outbound reply text can be
          // redacted no matter what the model decides to echo (live find
          // a fresh Supabase secret was pasted into the chat).
          try { require('./secret-redactor.js').harvest(resultContent); } catch (_) {}
          // Token-blowup guard. Tool results land in `messages`
          // and get RESENT on every remaining iteration of this turn — one
          // uncapped web_fetch/dialogue_search of a few hundred KB turned a
          // short session into ~163k input tokens (operator's CLI status
          // line). Cap each result, say exactly what was cut, and tell the
          // model how to get the rest. Callers with a real need for bigger
          // results (autonomous step-engine) override via
          // action.options.tool_result_max_chars.
          const resultCap = Number(baseOptions.tool_result_max_chars) > 0
            ? Number(baseOptions.tool_result_max_chars)
            : 32000;
          if (resultContent.length > resultCap) {
            trace.push({ iter, tool_result_truncated: { tool: (tc.function && tc.function.name) || 'unknown', kept: resultCap, total: resultContent.length } });
            resultContent = resultContent.slice(0, resultCap) +
              '\n\n[tool result truncated: showing first ' + resultCap + ' of ' +
              resultContent.length + ' chars. Re-call with a narrower query/range if you need the rest.]';
          }
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: resultContent
          });
          // Extract the call's TARGET RESOURCE once ({path,file_path,url,
          // command,query} — the common tool-arg shapes); the failure
          // bookkeeping and the loop detector below both key off it.
          let args = {};
          try { args = tc.function && tc.function.arguments
            ? JSON.parse(tc.function.arguments) : {};
          } catch (_) { args = {}; }
          const target = args.path || args.file_path || args.url ||
                         args.command || args.query || args.target || '';
          // World-change tracker for the identical-call refusal above. Only
          // EXECUTED results feed the streak — a refusal payload is always
          // identical to itself and would freeze the streak at >=2 forever.
          if (!_tcRefused && SIDE_EFFECT_DEDUP.has(_tcName)) {
            const _rh = require('crypto').createHash('sha1')
              .update(resultContent.slice(0, 4096)).digest('hex').slice(0, 12);
            const _prevSE = sideEffectLast.get(_tcKey);
            sideEffectLast.set(_tcKey, { hash: _rh, streak: _prevSE && _prevSE.hash === _rh ? _prevSE.streak + 1 : 1 });
          }
          // Anti-LARP bookkeeping: only for actions that actually DO something
          // (SIDE_EFFECT_DEDUP). A failed Read is normal exploration; a failed
          // Write/Bash/mcp_call/intent_emit the model glosses over is the
          // 'said done but did not' case. A dedup REFUSAL is excluded: by
          // construction the action already executed — stapling 'did NOT
          // complete' over a completed action is the false alarm this whole
          // mechanism exists to prevent. The last real execution's verdict
          // (set or cleared below on ITS iteration) stays authoritative.
          if (SIDE_EFFECT_DEDUP.has(_tcName) && !_tcRefused) {
            const _failReason = _toolErrorReason(resultContent);
            if (_failReason) toolFailures.set(_tcKey, { name: _tcName, reason: _failReason, target });
            else {
              toolFailures.delete(_tcKey);
              // Recovery is rarely an IDENTICAL retry: a failed hashline Edit
              // is retried with FRESH line hashes — new args, new signature —
              // so its stale failure stapled a RECOVERED action forever
              // A later SUCCESS of the same tool, or of
              // its file-mutation sibling (Write<->Edit), on the SAME target
              // clears the pending failure.
              if (target) {
                for (const [_fk, _fv] of toolFailures) {
                  if (!_fv || _fv.target !== target) continue;
                  const _sib = FILE_MUTATORS.has(_fv.name) && FILE_MUTATORS.has(_tcName);
                  if (_fv.name === _tcName || _sib) toolFailures.delete(_fk);
                }
              }
            }
          }
          // Record this transition for the loop detector. If the model's
          // calling the same tool with the same target N times, that's the
          // signal the detector exists for.
          // PROGRESS-AWARE signature. Tool+target alone made every
          // normal editing session look like a loop: Read->Edit->Read->Edit on
          // ONE file is the canonical workflow, but 4 same-target calls tripped
          // repeat_threshold and the 3rd detection ABORTED the turn — every real
          // chat task on a single file died as "(Stopped before finishing.)"
          // traces show the abort landing while the model was already
          // writing its answer. A loop is NO-PROGRESS
          // repetition, so the signature now includes the call's arguments AND
          // its result: a verify-Read after each different edit sees different
          // content (different hash, no repeat), while a genuinely stuck loop
          // (same call, same result, nothing changing) still counts up and
          // still aborts. Result hash is capped so huge tool outputs stay cheap.
          const progressHash = require('crypto').createHash('sha1')
            .update(String((tc.function && tc.function.arguments) || ''))
            .update(String(resultContent || '').slice(0, 4096))
            .digest('hex').slice(0, 12);
          loopTransitions.push({
            step_name:       'agentic_loop',
            tool_invoked:    (tc.function && tc.function.name) || 'unknown',
            target_resource: String(target).slice(0, 200) + '#' + progressHash
          });
        }
        if (cancelHit()) { aborted = true; abortReason = cancelReason(); break; }
        // Loop-detector check: scan the in-memory transitions accumulated
        // so far this turn. On 'abort' bail out immediately with an
        // explicit reason so callers can distinguish loop-abort from
        // timeout/iter-cap. 'escalate' surfaces in the trace but lets the
        // turn continue (coordinator decides whether to ask user).
        const detection = loopDetector.detectInMemory({
          transitions:      loopTransitions,
          priorDetections:  loopPriorDetections
        });
        if (detection.detected) {
          loopPriorDetections++;
          trace.push({ iter, loop_detection: detection });
          if (detection.action === 'abort') {
            aborted = true;
            abortReason = 'loop_detected';
            maybeAbort(transport, stream);
            break;
          }
          // 'warn' + 'escalate' fall through — turn continues but the
          // detection is now in the trace for the caller to inspect.
        }
        // Loop continues — model gets to see tool results next iteration.
        continue;
      }

      // No tool_calls. If the model spoke, that text IS the answer.
      // But if it went SILENT right after running tools (weak local models and
      // some providers return an empty turn after a tool-result round-trip),
      // do NOT ship a bare "Done." — force ONE explicit answer pass so the user
      // actually gets a reply built from what the tools found.
      if (!turnText.trim() && toolCallsMade && !forcedAnswer) {
        forcedAnswer = true;
        messages.push({
          role: 'user',
          content: 'Now answer my question directly and concisely using the information the tools returned above. Do NOT call any more tools — just give me the answer in plain language.'
        });
        trace.push({ iter, forced_answer: true });
        continue;
      }
      // A COMPLETELY empty turn (no text ever streamed, no tool ran, clean
      // done) must not surface as ok-with-empty-text: the user would see
      // SILENCE presented as success. Tag it transport_empty so the entity's
      // cross-faculty walk can rescue it, mirroring subprocess-cli's
      // cli_empty contract (first live find of the operator simulator,
      // a stream that ends bare-done escaped as an empty ok).
      if (!finalText.trim() && !toolCallsMade && !cancelHit()) {
        // Carry an honest line, not empty text: the cross-faculty walk keys
        // on the transport_ reason and zero streamed chars (never on text),
        // but a HARD-PINNED engine has no walk - without this line the user
        // stares at an empty terminal.
        return {
          status: 'aborted', reason: 'transport_empty_turn',
          text: '(The model returned nothing. Try again; if it keeps happening, switch engines in Settings.)',
          trace, served_by: servedBy,
          usage: _usageOut()
        };
      }
      // Text-only turn (or already forced) — we're done. Final text passes the
      // structural secret wall: any tool-result secret the model echoed is
      // masked here regardless of stream behavior.
      return { status: 'ok', reason: null, text: require('./secret-redactor.js').redact(withFailureNote(finalize())), trace, served_by: servedBy, usage: _usageOut() };
    }

    // Honest tail: if we were ABORTED (timeout / loop), do NOT claim "Done." —
    // that's the bandaid that made a timed-out half-finished turn look like a
    // success with no result. Say plainly it was cut short.
    let tailText;
    if (aborted) {
      tailText = (finalText && finalText.trim())
        ? finalText
        : (abortReason === 'timeout'
            ? '(Stopped — the model took too long to finish. Try again, or break the task into smaller steps.)'
            : (abortReason && abortReason.indexOf('transport_') === 0)
                ? '(Could not reach the language-model endpoint — it looks offline. If you set a Custom endpoint, make sure that machine is reachable; otherwise switch to the Automatic/local model in Settings.)'
                : '(Stopped before finishing.)');
    } else {
      // Iteration budget exhausted MID-WORK: a genuine completion returns as
      // a text-only turn above, so any non-aborted arrival here was cut off.
      // finalize()'s "Done." fallback must not stand alone — a capped turn
      // with no closing text shipped a synthesized "Done." over a half-done
      // task. Keep whatever real text exists, then say
      // plainly where it stopped and how to resume.
      const base = (finalText && finalText.trim()) ? finalText.trim() : '';
      tailText = (base ? base + '\n\n' : '') +
        '[Stopped at the iteration budget (' + max_iterations + ' rounds) before finishing — ' +
        'the work above may be incomplete. Say "continue" to resume where it left off.]';
    }
    return {
      status: aborted ? 'aborted' : 'ok',
      reason: aborted ? abortReason : 'iteration_cap',
      // Same structural secret wall as the text-only return above.
      text: require('./secret-redactor.js').redact(withFailureNote(tailText)),
      trace,
      served_by: servedBy
    };
  }

  return { callOnce, compose, composeAgentic };
}

// _honestStartFailure - synthesize the operator-facing text for a transport
// that threw BEFORE it streamed anything (a pre-stream START failure: no key,
// bad config, unwired module). The catch around transport.stream() used to
// return EMPTY text here, which the surface rendered as a silent dead panel
// (studio p10 phase-C,: kimi_sub with no TROTH_KIMI_SUB_KEY threw
// no_api_key and the operator saw nothing). Faculty-agnostic: correct for any
// engine whose stream() throws on start. Names the engine (when known) and a
// SANITIZED reason. The sanitizer NEVER echoes key material: any long
// key-shaped token (sk-..., long base64/hex runs, bearer-style secrets) is
// redacted, and the whole line is length-bounded, so an error string that
// happened to embed a key can never leak through this text.
function _sanitizeStartError(msg) {
  let s = String(msg == null ? '' : msg);
  // Redact anything key-shaped: sk-/bearer-prefixed tokens, and any long
  // unbroken alphanumeric/base64/hex run (>=20 chars) that could be a secret.
  s = s.replace(/\b(sk|xai|gsk|api|key|bearer|token)[-_ ]?[A-Za-z0-9._-]{8,}/gi, '[redacted]');
  s = s.replace(/\b[A-Za-z0-9+/_-]{20,}={0,2}\b/g, '[redacted]');
  // Collapse whitespace and bound length so the line stays a short reason.
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > 200) s = s.slice(0, 200) + '…';
  return s;
}

function _honestStartFailure(facultyLabel, err) {
  const label = String(facultyLabel || '').trim();
  const name = label ? label : 'the language-model';
  const reason = _sanitizeStartError(err && err.message ? err.message : err);
  const why = reason ? (': ' + reason) : '';
  return '(The ' + name + ' engine could not start' + why
    + '. Check its key or settings, or switch engines in Settings.)';
}

function _toolErrorReason(content) {
  // Short failure reason if a tool result signals an error, else null.
  const s = String(content || '');
  let obj = null;
  try { obj = JSON.parse(s); } catch (_) { obj = null; }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    // Carry the most useful context into the staple line: a bare token like
    // 'path_policy_refusal' told the operator nothing about WHICH path was
    // refused, and a diagnosis can hinge entirely on the path being
    // ~/.env.local instead of the workspace one.
    if (obj.error) {
      const ctx0 = obj.path ? ' (' + obj.path + ')'
        : obj.reason ? ' (' + obj.reason + ')'
        : obj.detail ? ': ' + obj.detail : '';
      return String(obj.error + ctx0).slice(0, 140);
    }
    if (obj.refused) return String(obj.refused).slice(0, 140);
    if (obj.ok === false) return String(obj.reason || obj.detail || 'failed').slice(0, 140);
    // An explicit success verdict wins over any text grep below: a web_fetch
    // whose page CONTENT mentions "connection refused" or "unauthorized" is
    // not a failed action — the words belong to the fetched page.
    if (obj.ok === true) return null;
    // Structured execution results (Bash-shaped: stdout/stderr/exitCode/
    // interrupted/signal) are judged by their exit metadata, NEVER by
    // grepping their text. A SUCCESSFUL command whose stderr happens to
    // grumble "No such file or directory" (find/grep scanning a tree) is
    // not a failure — that exact false staple fired live on:
    // a 63-action turn flagged over find's docs-path noise with exitCode 0.
    if (Object.prototype.hasOwnProperty.call(obj, 'exitCode')) {
      if (obj.interrupted === true) return 'interrupted before completion';
      if (obj.signal) return ('killed by signal ' + obj.signal).slice(0, 140);
      if (obj.exitCode === 0) return null;
      // Nonzero exit falls through to the text shapes below on purpose:
      // a grep miss exits 1 and is not a failure; a real failure usually
      // says why in stderr and matches a shape.
    }
  }
  // Plain-text failure shapes that side-effecting tools emit.
  if (/unknown downstream server|not logged in|unauthorized|permission denied|command not found|no such file|ENOENT|traceback \(most recent|refused|intent_refused/i.test(s)) {
    return s.replace(/\s+/g, ' ').trim().slice(0, 140);
  }
  return null;
}

function maybeAbort(transport, stream) {
  if (typeof transport.abort === 'function') {
    try { transport.abort(stream); } catch (_) { /* best-effort */ }
  }
}

function continuationPrompt(action, fragmentsSoFar) {
  // Bound the join — we are passing this back through the LLM so we want
  // it to see what it has produced without re-paying full context.
  const so_far = fragmentsSoFar.join(' ').slice(-1200);
  return (action.prompt || '') + '\n\nContinue from: "' + so_far + '"';
}

function looksComplete(text) {
  if (!text || text.length < 40) return false;
  return /[\.\!\?\u3002\uFF01\uFF1F]\s*$/.test(text);
}

module.exports = { makeOrchestrator, parseTextToolCalls, _honestStartFailure, _sanitizeStartError };
