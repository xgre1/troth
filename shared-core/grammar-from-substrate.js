// SPDX-License-Identifier: AGPL-3.0-only
// grammar-from-substrate — OPTIONAL decode-time content-policy
// constraints. Use this ONLY when you need a content compliance layer
// (regulated SaaS, legal/medical/financial domain wrapper) on top of
// substrate. THIS IS NOT SUBSTRATE IDENTITY — substrate identity is
// who the collaborator IS (preferences, context, voice, focus), built
// via prefix_provider + engram + dialogue-memory. Content guardrails
// are a separate layer.
//
// When wired, this module translates a content-policy configuration
// into decode-time constraints the language faculty must honor at the
// token-sampling step (logit_bias / GBNF grammar / stop sequences).
// The argument name `refusals` is historical; treat it as
// "policy-suppressed phrasing" — text patterns the deployment wants
// the model to never emit.
//
// Output shape (consumed by transports/llamacpp.js):
//   {
//     grammar:       <GBNF string | null>,   // structural constraint
//     json_schema:   <object | null>,        // structural constraint (alt)
//     bias_strings:  [<phrase>, ...],        // suppressed at decode
//     bias_amount:   <number>                // applied per token
//   }
//
// Substrate caller decides which knobs to use. v0.1 default: no grammar,
// suppress refusal red-flag phrases via logit bias. Future: substrate
// may emit a JSON schema for structured replies, or a GBNF that forces
// citation tokens after factual claims.
//
// Why both grammar AND bias: grammar is binary (token allowed or not).
// Bias is graded (nudges probability). Refusals belong on bias for
// flexibility — the model can still discuss medical topics, just not
// dispense advice. Structural shape (e.g., must-be-JSON) belongs on
// grammar where binary is exactly right.

const DEFAULT_BIAS_AMOUNT = -100;

// Multilingual equivalents for the substrate's most common refusal
// vocabulary. Models like Gemma 4 / Qwen are multilingual and will
// route around an English-only bias by emitting the same concept in
// another language ("медицинский" / "医疗" instead of "medical").
// When opts.cross_lingual is true, every English bias string with a
// known equivalence class also biases its translations.
//
// Coverage chosen pragmatically: the languages most multilingual models
// fall through to first when an English path is blocked. Add more by
// extending the table — pure data, no logic change required.
const CROSS_LINGUAL = {
  'medical':    ['медицинский', '医疗', 'médical', 'médico', 'medizinisch', '医療', 'طبي'],
  'advice':     ['совет', '建议', 'conseil', 'consejo', 'Ratschlag', 'アドバイス', 'نصيحة'],
  'recommend':  ['рекомендую', '推荐', 'recommande', 'recomiendo', 'empfehle', '推奨', 'أوصي'],
  'prescribe':  ['прописать', '开处方', 'prescrire', 'prescribir', 'verschreiben', '処方', 'وصف'],
  'doctor':     ['врач', '医生', 'médecin', 'médico', 'Arzt', '医者', 'طبيب'],
  'physician':  ['врач', '内科医', 'médecin', 'médico', 'Arzt', '医師', 'طبيب'],
  'medication': ['лекарство', '药物', 'médicament', 'medicamento', 'Medikament', '薬', 'دواء'],
  'dosage':     ['дозировка', '剂量', 'posologie', 'dosis', 'Dosierung', '投与量', 'جرعة'],
  'legal':      ['юридический', '法律', 'juridique', 'legal', 'rechtlich', '法律', 'قانوني'],
  'financial':  ['финансовый', '财务', 'financier', 'financiero', 'finanziell', '財務', 'مالي']
};

function buildConstraints(stateSlice, opts) {
  stateSlice = stateSlice || {};
  opts = opts || {};
  const refusals = Array.isArray(stateSlice.refusals) ? stateSlice.refusals : [];
  const anchors  = Array.isArray(stateSlice.anchors)  ? stateSlice.anchors  : [];

  const bias_strings = [];

  // Refusal-derived bias strings: pull the actionable predicate out of
  // each refusal sentence. "I do not provide medical advice that..."
  // → "medical advice". Short fragments tokenize cleanly and apply
  // pressure exactly where the model would otherwise volunteer the
  // forbidden behavior.
  // Refusal-derived bias strings: substrate suppresses the OFFENDING
  // VERB+OBJECT combination, NOT the subject domain words on their own.
  // Critical lesson from benchmark ENT-eval-1: biasing single domain
  // words like "medical", "doctor", "healthcare", "consult" tanks
  // compliance because the model's refusal language USES those exact
  // words ("consult a doctor", "see a healthcare provider"). Bias the
  // ACTION ("I recommend taking", "the right dose is"), not the LABEL.
  for (const r of refusals) {
    if (typeof r !== 'string') continue;
    const m = r.match(/I (?:do not|don't|will not|won't|never) (?:provide|recommend|suggest|advise|prescribe|dispense) ([a-z][a-z, ]+?)(?: that| which| when| if|\.|$)/i);
    if (m && m[1]) {
      const fragment = m[1].split(/[,;]/)[0].trim();
      // Single-word fragments (e.g., "medical") are too dangerous —
      // they collide with compliance vocabulary. Skip them.
      if (fragment && /\s/.test(fragment)) bias_strings.push(fragment);
    }
  }

  // Anchor-derived bias: anchors phrased as positive commitments imply
  // their opposite is undesirable. "I report uncertainty rather than
  // confabulate" → suppress confident hedge-erasers like "definitely",
  // "certainly", "guaranteed" when the substrate is in research mode.
  // v0.1 keeps this opt-in via opts.bias_anchor_opposites; default off
  // to avoid surprising the caller.
  if (opts.bias_anchor_opposites) {
    for (const a of anchors) {
      if (typeof a !== 'string') continue;
      if (/uncertainty|confabulate/i.test(a)) {
        bias_strings.push('definitely', 'certainly', 'guaranteed', 'absolutely');
      }
      if (/cite (?:sources|evidence)/i.test(a)) {
        // No direct opposite; substrate would express via grammar
        // (require citation tokens after claims) — out of v0.1 scope.
      }
    }
  }

  // Caller-provided extras — useful when the substrate's red-flag
  // patterns are expressed as regexes (which we can't easily reverse
  // back to literal phrases). The demo binary's REFUSAL_RED_FLAGS is
  // exactly this case: pass the literal fragments here.
  //
  // Caller responsibility: extras MUST be multi-word phrases that
  // capture the offending action ("I recommend taking", "specific
  // legal advice for your situation"). Single domain words ("medical",
  // "doctor", "healthcare") will be filtered out — see the earlier
  // refusal-derived loop for the rationale.
  if (Array.isArray(opts.extra_bias_strings)) {
    for (const s of opts.extra_bias_strings) {
      if (typeof s !== 'string') continue;
      const trimmed = s.trim();
      if (!trimmed) continue;
      // Reject single-word entries — they collide with compliance
      // vocabulary. Multi-word phrases survive.
      if (!/\s/.test(trimmed)) continue;
      bias_strings.push(trimmed);
    }
  }

  // Compliance-vocabulary preservation: substrate explicitly LIFTS
  // (positive logit bias) the words that proper refusal language
  // depends on, so even if some indirect interaction would dampen
  // them, the compliance path stays open. Caller can override the
  // default vocabulary via opts.compliance_boost_strings; default
  // covers medical / legal / financial professional-redirect words.
  const compliance_boost_strings = Array.isArray(opts.compliance_boost_strings)
    ? opts.compliance_boost_strings.slice()
    : [
        'consult', 'consultation', 'professional', 'qualified',
        'doctor', 'physician', 'healthcare', 'pharmacist',
        'lawyer', 'attorney', 'tax advisor', 'specialist'
      ];
  const compliance_boost_amount = typeof opts.compliance_boost_amount === 'number'
    ? opts.compliance_boost_amount : 2;

  // Cross-lingual coverage: when the model is multilingual (Gemma 4,
  // Qwen, Llama 3) an English-only bias gets routed around by emitting
  // the same concept in another language. Substrate opts in via
  // cross_lingual:true; we expand each known English term into its
  // translation set. No-op for languages outside the equivalence table.
  if (opts.cross_lingual) {
    const additions = [];
    for (const s of bias_strings) {
      const key = String(s).trim().toLowerCase();
      const translations = CROSS_LINGUAL[key];
      if (Array.isArray(translations)) {
        for (const t of translations) additions.push(t);
      }
      // Multi-word phrases — try the first word as a fallback key
      const firstWord = key.split(/\s+/)[0];
      if (firstWord !== key && CROSS_LINGUAL[firstWord]) {
        for (const t of CROSS_LINGUAL[firstWord]) additions.push(t);
      }
    }
    for (const a of additions) bias_strings.push(a);
  }

  // Optional stop_sequences — graded bias is the primary instrument,
  // but for hard "if this exact phrase appears, terminate immediately"
  // policies, stop sequences are the right primitive. Caller opts in
  // by passing stop_sequences directly OR by setting derive_stops=true
  // in which case the same refusal-derived fragments become both bias
  // tokens AND stop sequences (belt + suspenders).
  let stop_sequences = Array.isArray(opts.stop_sequences) ? opts.stop_sequences.slice() : [];
  if (opts.derive_stops) {
    for (const s of bias_strings) {
      if (typeof s === 'string' && s.length >= 4) stop_sequences.push(s);
    }
  }

  return {
    grammar:                    opts.grammar     || null,
    json_schema:                opts.json_schema || null,
    bias_strings:               dedupe(bias_strings),
    bias_amount:                typeof opts.bias_amount === 'number' ? opts.bias_amount : DEFAULT_BIAS_AMOUNT,
    stop_sequences:             dedupe(stop_sequences),
    compliance_boost_strings:   dedupe(compliance_boost_strings),
    compliance_boost_amount
  };
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (!seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

module.exports = { buildConstraints, DEFAULT_BIAS_AMOUNT };
