// SPDX-License-Identifier: AGPL-3.0-only
// llama.cpp HTTP transport for the Substrate-as-Entity orchestrator.
//
// Implements the same contract as transports/ollama.js:
//   stream({ system, user, options }) → AsyncIterable<{ delta?, done? }>
//   abort(streamHandle)
//
// Difference vs Ollama: this transport plumbs decode-time constraints
// (grammar, logit_bias, prefix-cache) all the way through to the
// inference engine. The substrate's refusal commitments stop being
// observed-and-cancelled and start being PHYSICALLY UNVIOLATABLE at
// the token-sampling step. That's the dream property the project is
// chasing — substrate IN the computation graph, not adjacent to it.
//
// Configuration via env (read at call time):
//   TROTH_LLAMACPP_HOST   — base URL (default http://127.0.0.1:11436)
//                             For a remote host: tunnel via
//                             ssh -f -N -L 11436:localhost:11436 <host>
//   TROTH_LLAMACPP_MODEL  — model identifier passed in body (mostly
//                             cosmetic; llama-server already loaded one)
//
// Substrate plumbs constraints via req.options.substrate_decode_constraints
// (shape from shared-core/grammar-from-substrate.js):
//   { grammar, json_schema, bias_strings, bias_amount }
//
// On every call, this transport pre-tokenizes bias_strings via the
// /tokenize endpoint, builds a {token_id: bias} map, and POSTs to
// /v1/chat/completions with stream:true. The server enforces the
// constraints during decode.

const http = require('http');
const https = require('https');
const { URL } = require('url');
const cfg   = require('../transport-config.js');

function makeLlamaCppTransport(opts) {
  opts = opts || {};
  const hostDefault  = opts.host  || null;
  const modelDefault = opts.model || null;

  // Best-effort tokenize a single string via llama-server /tokenize.
  // Returns array of token ids (or [] on any failure — bias becomes
  // a no-op rather than failing the whole stream).
  function tokenize(host, content) {
    return new Promise((resolve) => {
      const url = new URL('/tokenize', host);
      const lib = url.protocol === 'https:' ? https : http;
      const body = JSON.stringify({ content });
      const req = lib.request({
        method:   'POST',
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname + url.search,
        headers:  {
          'content-type':   'application/json',
          'content-length': Buffer.byteLength(body)
        },
        timeout:  5000
      }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(buf);
            if (j && Array.isArray(j.tokens)) return resolve(j.tokens);
          } catch (_) { /* fall through */ }
          resolve([]);
        });
      });
      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
      req.write(body);
      req.end();
    });
  }

  // Build a {tokenId: bias} map combining negative bias_strings AND
  // optional positive boost_strings. Boosts override suppressions if
  // the same token id appears on both lists (compliance vocab wins).
  async function buildLogitBias(host, biasStrings, biasAmount, boostStrings, boostAmount) {
    if ((!Array.isArray(biasStrings) || !biasStrings.length) &&
        (!Array.isArray(boostStrings) || !boostStrings.length)) return null;
    const out = {};
    // SentencePiece-family tokenizers (Gemma, Qwen, Llama) emit DIFFERENT
    // token ids for "word" vs " word" (leading space). When the model
    // generates a word mid-sentence it almost always uses the leading-
    // space variant. Biasing only the no-space form is a no-op in practice.
    // Same for capitalized variants that may start a sentence. We expand
    // each bias string into the set of (lowercase/Capital × no-space/lead-
    // space) variants and tokenize each, accumulating all unique ids.
    function expand(s) {
      const v = new Set();
      const cap = s.length ? s[0].toUpperCase() + s.slice(1) : s;
      v.add(s);
      v.add(' ' + s);
      if (cap !== s) {
        v.add(cap);
        v.add(' ' + cap);
      }
      return Array.from(v);
    }
    if (Array.isArray(biasStrings)) {
      for (const s of biasStrings) {
        for (const variant of expand(String(s))) {
          const tokens = await tokenize(host, variant);
          for (const t of tokens) {
            if (typeof t === 'number' && t > 2) out[String(t)] = biasAmount;
          }
        }
      }
    }
    // Apply boosts AFTER bias so compliance vocab wins on collision.
    if (Array.isArray(boostStrings) && typeof boostAmount === 'number') {
      for (const s of boostStrings) {
        for (const variant of expand(String(s))) {
          const tokens = await tokenize(host, variant);
          for (const t of tokens) {
            if (typeof t === 'number' && t > 2) out[String(t)] = boostAmount;
          }
        }
      }
    }
    return Object.keys(out).length ? out : null;
  }

  function stream(req) {
    const host  = hostDefault || cfg.llamacppHost();
    const model = (req.options && req.options.model) || modelDefault || cfg.llamacppModel();
    const url   = new URL('/v1/chat/completions', host);
    // Last-use stamp for the proxy's idle reaper. The chat server only
    // stamped at SPAWN (server-lifecycle waitForHealth), so a model in
    // continuous use for >60min was reaped mid-conversation and had to
    // cold-reload on the next turn — the slowest respawn in the fleet
    //. Stamp per call, exactly like the embedder
    // and reranker do. Loopback only: a remote llama box is not ours to
    // reap, and stamping it would just be a lie in the local ledger.
    try {
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
        const fs = require('fs'), path = require('path'), os = require('os');
        const dir = path.join((process.env.HOME || os.homedir()), '.troth');
        fs.mkdirSync(dir, { recursive: true });
        const p = url.port || (url.protocol === 'https:' ? 443 : 80);
        fs.writeFileSync(path.join(dir, 'lastuse-' + p + '.txt'), String(Date.now()));
      }
    } catch (_) { /* stamping is housekeeping, never a turn blocker */ }

    // Two construction modes:
    //  (a) caller supplies req.messages directly — used by the agentic
    //      tool loop when conversation history (assistant + tool turns)
    //      must be preserved across rounds.
    //  (b) caller supplies req.system + req.user — single-shot path.
    let messages;
    if (Array.isArray(req.messages) && req.messages.length) {
      messages = req.messages;
    } else {
      messages = [];
      if (req.system) messages.push({ role: 'system', content: String(req.system) });
      messages.push({ role: 'user', content: String(req.user || '') });
    }

    const constraints = (req.options && req.options.substrate_decode_constraints) || {};
    const grammar     = constraints.grammar     || null;
    const json_schema = constraints.json_schema || null;
    const biasStrings = Array.isArray(constraints.bias_strings) ? constraints.bias_strings : [];
    const biasAmount  = typeof constraints.bias_amount === 'number' ? constraints.bias_amount : -100;
    const cachePrompt = constraints.cache_prompt !== false; // default true

    const queue = [];
    const waiters = [];
    let ended = false;
    let error = null;
    let reqHandle = null;
    // Truncation honesty: an OpenAI-compatible
    // stream always carries a finish_reason on its final chunk. If res.on('end')
    // fires without one, the socket dropped mid-generation (server crash,
    // killed model process, connection reset) and any streamed text is a
    // truncated fragment. Track it so the end handler aborts instead of
    // shipping the fragment as a clean, complete answer.
    let sawFinish = false;
    let aborted = false;

    function emit(ev) {
      if (waiters.length) waiters.shift()(ev);
      else queue.push(ev);
    }
    function next() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (ended) return Promise.resolve(null);
      if (error) return Promise.reject(error);
      return new Promise((r) => waiters.push(r));
    }

    // Build logit_bias map asynchronously, then fire the completion.
    // We can't yield tokens until tokenize completes — that's a small
    // up-front latency cost the substrate accepts in exchange for the
    // decode-time guarantee.
    const boostStrings = Array.isArray(constraints.compliance_boost_strings) ? constraints.compliance_boost_strings : null;
    const boostAmount  = typeof constraints.compliance_boost_amount === 'number' ? constraints.compliance_boost_amount : 2;

    (async () => {
      let logit_bias = null;
      try {
        logit_bias = await buildLogitBias(host, biasStrings, biasAmount, boostStrings, boostAmount);
      } catch (_) { /* best-effort */ }

      if (aborted) { ended = true; emit({ done: true, _abort_reason: 'aborted_pre_request' }); return; }

      const bodyObj = {
        model,
        messages,
        stream: true,
        cache_prompt: cachePrompt,
        // n_predict — generation token budget.: raised from
        // 512 to 2048 because Qwen3+ / DeepSeek-R1 / Gemma3-thinking
        // routinely spend several hundred tokens on internal reasoning
        // BEFORE emitting any user-facing `content`. 512 was enough for
        // the pre-thinking-default era when models answered directly;
        // post-thinking-default it became a hidden cap that produced
        // empty `content` (model exhausted budget on reasoning, never
        // reached the answer). 2048 covers typical reasoning + answer
        // for trivial-to-moderate prompts; caller still overrides for
        // long-form tasks via options.n_predict.
        // Same knob as the hosted lanes (TROTH_ENTITY_MAX_TOKENS), but the
        // local fallback stays hardware-sized at 4096: a looping local model
        // pays its cap in wall-clock on the operator's own machine, and the
        // loop rescue below is the net, not the budget.
        n_predict: (req.options && req.options.n_predict) ||
          parseInt(process.env.TROTH_ENTITY_MAX_TOKENS || '4096', 10),
        // Slot pinning: when the substrate wants the model's KV cache to
        // persist across calls (e.g., a back-and-forth with the same
        // agent), pinning to a specific slot id keeps the cache hot
        // between requests. Without this, llama-server may rotate slots
        // and the next call's prefix re-tokenizes from scratch. Substrate
        // also needs the slot id to subsequently save its KV state.
        ...((req.options && req.options.slot_id != null)
          ? { id_slot: req.options.slot_id }
          : {}),
        // chain-of-thought / thinking-mode handling.
        //
        // The substrate IS the cross-turn deliberation layer (persistent
        // memory, intent routing, multi-axis retrieval, procedure
        // matching). The MODEL has its own within-turn reasoning layer
        // (the "thinking" / "reasoning_content" stream emitted by
        // Qwen3+ / Gemma3+ / o-series / DeepSeek-R1). These are
        // DIFFERENT scopes — they don't compete.
        //
        // Earlier default forced thinking OFF
        // out of a stated concern that it "doubles latency and splits
        // the evaluator path". Empirical result on Qwen 3.6: forcing
        // thinking off destroyed coherence on even trivial prompts
        // ("what is 1+1" → "1 plus 1 equals 2.1 plus 1 equals 2.1 plus
        // 1 equals 2." looped to budget cap). Coherence collapse on a
        // model trained WITH thinking is not a substrate win.
        //
        //  → default ON. Models that don't think (older
        // Llama, plain Mistral) ignore the flag harmlessly. The
        // substrate's evaluator path still works because the user-facing
        // delta stream (read below) emits ONLY `delta.content`, not
        // `delta.reasoning_content` — the model's internal scratchpad
        // stays internal. Caller can still override via
        // options.enable_thinking=false (e.g., voice latency mode where
        // the brevity guard makes reasoning overkill).
        chat_template_kwargs: {
          enable_thinking: (req.options && req.options.enable_thinking === false) ? false : true
        }
      };
      if (grammar)     bodyObj.grammar = grammar;
      if (json_schema) bodyObj.json_schema = json_schema;
      if (logit_bias)  bodyObj.logit_bias = logit_bias;
      // Substrate-tools surface: model can call back into substrate
      // mid-generation. Caller passes the tools array (OpenAI schema
      // shape) and optionally tool_choice ('auto', 'none', or {type,function}).
      if (req.options && Array.isArray(req.options.tools) && req.options.tools.length) {
        bodyObj.tools = req.options.tools;
        if (req.options.tool_choice != null) bodyObj.tool_choice = req.options.tool_choice;
      }
      // Ollama-style stop sequences also work on llama-server (passed
      // straight to the sampler). Substrate-supplied phrases stop the
      // decode loop instantly when produced — complement to logit_bias.
      //
      //  added default chat-template stop tokens. Without
      // these, Qwen3 / Llama3 / Mistral chat models that DON'T emit a
      // clean `finish_reason: stop` in streaming mode keep generating
      // until n_predict cap, often looping the same answer N times
      // ("One plus one equals two.One plus one equals two..."). Direct
      // non-streaming curl returns a single clean answer because the
      // server's non-stream path handles end-of-turn internally; the
      // stream path doesn't, so we have to teach the sampler which
      // tokens terminate the turn. Covers Qwen / Llama / Mistral / DeepSeek
      // family chat templates; harmless to models that use other markers.
      const DEFAULT_CHAT_STOPS = ['<|im_end|>', '<|endoftext|>', '<|eot_id|>', '</s>'];
      const callerStops = (req.options && req.options.stop) ||
                          (constraints && constraints.stop_sequences) || null;
      const stops = Array.isArray(callerStops) && callerStops.length
        ? callerStops.concat(DEFAULT_CHAT_STOPS)
        : DEFAULT_CHAT_STOPS;
      bodyObj.stop = stops;

      const body = JSON.stringify(bodyObj);
      if (process.env.TROTH_LLAMACPP_DEBUG === '1') {
        try { require('fs').appendFileSync('/tmp/gc-llamacpp-debug.log',
          '\n=== ' + new Date().toISOString() + ' ===\n' + body + '\n'); } catch (_) {}
      }
      const lib = url.protocol === 'https:' ? https : http;
      reqHandle = lib.request({
        method:   'POST',
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname + url.search,
        headers:  {
          'content-type':   'application/json',
          'content-length': Buffer.byteLength(body)
        }
      }, (res) => {
        if (process.env.TROTH_DEBUG_RAW === '1') { try { console.error('[DBG llamacpp] response status=' + res.statusCode); } catch (_) {} }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let chunks = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { chunks += c; });
          res.on('end', () => {
            error = new Error('llamacpp http ' + res.statusCode + ': ' + chunks.slice(0, 500));
            error.code = 'http_status';
            ended = true;
            while (waiters.length) waiters.shift()({ done: true, _abort_reason: 'http_error' });
          });
          return;
        }
        res.setEncoding('utf8');
        // SSE: each event is `data: {...}\n\n`. Some llama-server builds
        // also emit `data: [DONE]` as the terminator. We parse line-by-line.
        let buf = '';
        // --- TEMP DIAGNOSTIC (TROTH_DEBUG_RAW=1): per-turn breakdown of what
        // the model actually streamed, so we can tell empty-content apart from
        // all-reasoning / all-think / tool-loop. Remove after the empty-response
        // bug is root-caused.
        const _DBG = process.env.TROTH_DEBUG_RAW === '1';
        let _dbgContentRaw = 0, _dbgContentClean = 0, _dbgReason = 0, _dbgToolDeltas = 0, _dbgFinish = null, _dbgSample = '';
        // Defensive <think>…</think> stripper for delta.content.
        //
        // Some llama-server builds / chat templates emit Qwen3 / DeepSeek-R1
        // thinking blocks INLINE in delta.content (wrapped in <think>…</think>)
        // instead of routing them to delta.reasoning_content. Without
        // --reasoning-format deepseek + a template that honors it, the entire
        // chain-of-thought dumps into the user-facing stream — the agent
        // looks like it's monologuing its planning instead of acting.
        //
        //
        // We run a tiny streaming state machine over content chunks:
        //   - outside think block → emit
        //   - inside think block  → drop until </think>
        //   - boundary tags themselves never emitted
        // Tag spans may split across SSE chunks, so we buffer a small tail
        // (length of the longest tag) that could be a partial opening/closing
        // marker, and only emit the safe prefix.
        let thinkOpen = false;
        let thinkTail = '';
        const THINK_OPEN  = '<think>';
        const THINK_CLOSE = '</think>';
        const TAIL_KEEP   = THINK_CLOSE.length - 1; // 7 chars enough for either tag
        // Tool-intent rescue: local models
        // often emit their tool call INSIDE the thinking stream (non-jinja
        // servers especially). Both discard paths — the reasoning_content
        // channel and inline <think> spans — silently ate that intent, so
        // the turn ended as plain text and the partner LARPed ("talks,
        // never acts"). We accumulate the discarded thinking (bounded) and,
        // if the turn finishes with ZERO native tool_calls, re-emit just
        // the tool-markup spans as content so the orchestrator's
        // parseTextToolCalls net recovers them like any text-form call.
        let reasonAcc = '';
        const REASON_CAP = 65536;
        const reasonKeep = (piece) => {
          if (piece && reasonAcc.length < REASON_CAP) reasonAcc += piece;
        };
        const TOOL_SPAN_RE = /<tool_call>[\s\S]*?(?:<\/tool_call>|$)|<function=[\s\S]*?(?:<\/function>|$)/gi;
        function stripThink(chunk, flush) {
          let s = thinkTail + chunk;
          thinkTail = '';
          let out = '';
          while (s.length) {
            if (thinkOpen) {
              const end = s.indexOf(THINK_CLOSE);
              if (end < 0) {
                // No closer yet. Keep a tail that might be the start of
                // </think>; drop the rest as thinking content.
                thinkTail = flush ? '' : s.slice(Math.max(0, s.length - TAIL_KEEP));
                reasonKeep(flush ? s : s.slice(0, Math.max(0, s.length - TAIL_KEEP)));
                s = '';
              } else {
                reasonKeep(s.slice(0, end));
                s = s.slice(end + THINK_CLOSE.length);
                thinkOpen = false;
              }
            } else {
              const start = s.indexOf(THINK_OPEN);
              if (start < 0) {
                // No opener. Emit safe prefix, hold a small tail in case the
                // opener is split across chunks.
                if (flush) { out += s; s = ''; }
                else if (s.length > TAIL_KEEP) {
                  out += s.slice(0, s.length - TAIL_KEEP);
                  thinkTail = s.slice(s.length - TAIL_KEEP);
                  s = '';
                } else {
                  thinkTail = s;
                  s = '';
                }
              } else {
                out += s.slice(0, start);
                s = s.slice(start + THINK_OPEN.length);
                thinkOpen = true;
              }
            }
          }
          return out;
        }
        // tool_calls arrive as streaming partial deltas (OpenAI format):
        // each chunk has `{index, id?, function: {name?, arguments?}}`.
        // We accumulate by index across deltas so the orchestrator
        // receives the assembled call once `finish_reason: 'tool_calls'`
        // fires.
        const toolCallAcc = [];
        let sentServed = false; // R2: emit served_by once
        function mergeToolCallDelta(d) {
          const idx = typeof d.index === 'number' ? d.index : 0;
          if (!toolCallAcc[idx]) toolCallAcc[idx] = { id: null, function: { name: '', arguments: '' } };
          const slot = toolCallAcc[idx];
          if (d.id) slot.id = d.id;
          if (d.function) {
            if (d.function.name)      slot.function.name      += d.function.name;
            if (d.function.arguments) slot.function.arguments += d.function.arguments;
          }
        }
        res.on('data', (chunk) => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, '');
            buf = buf.slice(nl + 1);
            if (!line) continue;
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            if (payload === '[DONE]') { emit({ done: true }); continue; }
            let msg;
            try { msg = JSON.parse(payload); } catch (_) { continue; }
            // R2 (which-model display): surface the ACTUAL served model ONCE
            // (msg.model from llama-server, else the resolved request model) +
            // host, so the UI shows the real local/custom/remote model and can
            // distinguish "On this Mac" from a remote box — not a config guess.
            if (!sentServed) { sentServed = true; emit({ served_by: { provider: 'local', model: (msg && msg.model) || model, host: url.host } }); }
            // Token accounting: some llama.cpp builds attach usage to the
            // final chunk (stream_options or server default) — pass it up.
            if (msg && msg.usage) {
              emit({ usage: {
                input_tokens:  msg.usage.prompt_tokens     || msg.usage.input_tokens  || 0,
                output_tokens: msg.usage.completion_tokens || msg.usage.output_tokens || 0
              } });
            }
            // OpenAI-compatible delta path. Two streams may arrive
            // interleaved on Qwen3+ / DeepSeek-R1 / o-series:
            //   - delta.reasoning_content — the model's internal
            //     thinking (chain-of-thought scratchpad)
            //   - delta.content           — the user-facing final answer
            // We READ both but EMIT only content downstream. The
            // reasoning stream stays internal to the model's turn — it
            // never reaches the user's transcript, never gets logged
            // as the assistant_text in dialogue.turn, never bills as
            // visible context. (Substrate's cross-turn deliberation is
            // a separate layer; the model's within-turn reasoning is
            // a local sub-step that the substrate doesn't replace.)
            const delta = msg && msg.choices && msg.choices[0] && msg.choices[0].delta;
            if (_DBG && delta) {
              if (typeof delta.content === 'string') { _dbgContentRaw += delta.content.length; if (_dbgSample.length < 400) _dbgSample += delta.content; }
              if (typeof delta.reasoning_content === 'string') _dbgReason += delta.reasoning_content.length;
            }
            if (delta && typeof delta.content === 'string' && delta.content) {
              const clean = stripThink(delta.content, false);
              if (_DBG && clean) _dbgContentClean += clean.length;
              if (clean) emit({ delta: clean });
            }
            // delta.reasoning_content stays OUT of the transcript, but it must
            // still prove liveness: the orchestrator's 240s idle timer resets
            // only on yielded chunks, so a long thinking phase (enable_thinking
            // defaults true here) was PURE SILENCE to the timer and a healthy
            // deliberating Qwen died as reason:'timeout' with "(Stopped — took
            // too long)" mid-research (repro round,: server flat ~5s
            // per iteration, the only starvable path is thinking). Same cure as
            // claude_cli's --include-partial-messages: keepalive
            // chunks, never text. A "show your work" UI can still hook here via
            // a separate emit({ reasoning: ... }).
            if (delta && typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
              reasonKeep(delta.reasoning_content);
              emit({ keepalive: true });
            }
            if (delta && Array.isArray(delta.tool_calls)) {
              if (_DBG) _dbgToolDeltas += delta.tool_calls.length;
              for (const tc of delta.tool_calls) mergeToolCallDelta(tc);
            }
            const finishReason = msg && msg.choices && msg.choices[0] && msg.choices[0].finish_reason;
            if (_DBG && finishReason) _dbgFinish = finishReason;
            if (finishReason) {
              if (finishReason === 'tool_calls' && toolCallAcc.length) {
                emit({ tool_calls: toolCallAcc.slice(), finish_reason: 'tool_calls' });
              }
              // Flush any content held in the thinkTail buffer BEFORE signaling
              // done. Short final answers (≤ TAIL_KEEP chars — "Hi", "Done",
              // "OK", "4") live ENTIRELY in that look-ahead buffer and were
              // never emitted during streaming; the only flush was in
              // res.on('end'), which fires AFTER `done`, so the orchestrator
              // had already stopped consuming → empty "(no response)". Longer
              // answers silently lost their last ≤7 chars. Flushing here makes
              // the held tail reach the consumer before the turn closes.
              const heldTail = stripThink('', true);
              if (heldTail) { if (_DBG) _dbgContentClean += heldTail.length; emit({ delta: heldTail }); }
              if (finishReason !== 'tool_calls' && !toolCallAcc.length && reasonAcc) {
                // No native call materialized this turn. If the model wrote
                // its tool call inside the (discarded) thinking stream,
                // surface exactly those spans as content — the orchestrator's
                // parseTextToolCalls net turns them into real calls. Without
                // this the intent evaporated and the turn counted as a clean
                // text answer. Emitted AFTER
                // the tail flush so the span lands after the visible sentence
                // instead of spliced into it.
                const spans = reasonAcc.match(TOOL_SPAN_RE);
                if (spans && spans.length) emit({ delta: '\n' + spans.join('\n') });
                reasonAcc = '';
              }
              sawFinish = true;
              emit({ done: true, finish_reason: finishReason });
            }
          }
        });
        res.on('end', () => {
          // Flush any held tail. If the stream ended mid-think (no closing
          // tag arrived), drop the tail; the partial thinking buffer was
          // never meant for the user. If we ended outside a think block,
          // the tail is real content — emit it.
          const tail = stripThink('', true);
          if (tail) emit({ delta: tail });
          if (_DBG) {
            console.error(`[DBG llamacpp turn] contentRaw=${_dbgContentRaw} contentClean=${_dbgContentClean} reasoning=${_dbgReason} toolDeltas=${_dbgToolDeltas} finish=${_dbgFinish} sample=${JSON.stringify(_dbgSample.slice(0, 200))}`);
          }
          ended = true;
          // A finish_reason chunk already closed the turn honestly. If none
          // arrived, the stream was cut mid-generation: abort so the truncated
          // fragment does not surface as a clean, complete answer.
          if (sawFinish) { emit({ done: true }); return; }
          emit({ done: true, _abort_reason: 'stream_ended_without_finish' });
        });
        res.on('error', (e) => {
          if (_DBG) { try { console.error('[DBG llamacpp] res error: ' + (e && e.message)); } catch (_) {} }
          error = e;
          ended = true;
          while (waiters.length) waiters.shift()({ done: true, _abort_reason: 'stream_error' });
        });
      });
      reqHandle.on('error', (e) => {
        if (process.env.TROTH_DEBUG_RAW === '1') { try { console.error('[DBG llamacpp] req error: ' + (e && e.message)); } catch (_) {} }
        error = e;
        ended = true;
        while (waiters.length) waiters.shift()({ done: true, _abort_reason: 'request_error' });
      });
      if (process.env.TROTH_DEBUG_RAW === '1') { try { console.error('[DBG llamacpp] sending request body=' + body.length + 'b to ' + url.href); } catch (_) {} }
      reqHandle.write(body);
      reqHandle.end();
    })();

    const iter = {
      [Symbol.asyncIterator]() { return iter; },
      next: async () => {
        const ev = await next();
        if (ev === null) return { value: undefined, done: true };
        return { value: ev, done: false };
      },
      _abort: () => {
        aborted = true;
        try { if (reqHandle && !reqHandle.destroyed) reqHandle.destroy(); } catch (_) {}
      }
    };
    return iter;
  }

  function abort(streamHandle) {
    try { if (streamHandle && typeof streamHandle._abort === 'function') streamHandle._abort(); } catch (_) {}
  }

  return { stream, abort };
}

module.exports = { makeLlamaCppTransport };
