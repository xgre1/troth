// SPDX-License-Identifier: AGPL-3.0-only
// RouteLLM Lite — heuristic complexity-based router.
//
// Research [MW]: 85% cost cut at 95% GPT-4 quality with trained win-prediction
// model. Full version needs trained model on Chatbot Arena preferences.
// Lite version: deterministic complexity scoring → routes simple to cheap,
// complex to strong. Achieves cost-savings without ML training.
//
// Score 0-10:
//   0-3: trivial (1-line answers, formatting, naming) → cheap model
//   4-6: medium (single-file edits, small refactors) → mid model
//   7-10: complex (multi-file, architecture, debugging) → strong model

function scoreTaskComplexity(taskText, contextSize) {
  if (!taskText) return 5;
  let score = 0;
  const text = taskText.toLowerCase();
  const len = taskText.length;

  // Length-based base score
  if (len < 50) score += 1;
  else if (len < 150) score += 3;
  else if (len < 400) score += 5;
  else score += 7;

  // Architecture/multi-file keywords (+3 each)
  const archPatterns = [/\b(architecture|refactor|migrate|redesign)\b/, /\b(multiple|several) files?\b/, /\b(across|throughout) the (?:codebase|project)\b/];
  for (const p of archPatterns) if (p.test(text)) score += 3;

  // Debugging/complex reasoning (+2 each)
  const reasonPatterns = [/\bdebug\b/, /\bperformance\b/, /\boptimi[sz]e\b/, /\bsecurity\b/, /\brace condition\b/, /\bmemory leak\b/, /\bdeadlock\b/];
  for (const p of reasonPatterns) if (p.test(text)) score += 2;

  // Trivial markers (-3 each)
  const trivialPatterns = [/\brename\b.*\bto\b/, /\b(format|prettify|indent)\b/, /\b(typo|spelling)\b/, /\bjust (?:add|change|update)\b.*\bone\b/];
  for (const p of trivialPatterns) if (p.test(text)) score -= 3;

  // Question vs imperative (+2 if explanatory question — needs reasoning)
  if (/\b(why|how|explain|describe|what does)\b/.test(text)) score += 2;

  // Test/build verification mentions (+1 — usually multi-step)
  if (/\b(test|build|verify|check|run)\b/.test(text)) score += 1;

  // Context size factor — large context = complex
  if (contextSize > 50000) score += 2;
  else if (contextSize > 20000) score += 1;

  // Clamp to 0-10
  return Math.max(0, Math.min(10, score));
}

// Suggest provider tier based on complexity score.
// Returns: 'strong' | 'mid' | 'cheap'
function suggestTier(score) {
  if (score >= 7) return 'strong';
  if (score >= 4) return 'mid';
  return 'cheap';
}

// Build a routing recommendation from a request body
function recommendRoute(bodyStr) {
  try {
    const data = JSON.parse(bodyStr);
    const msgs = data.messages || [];
    let userText = '';
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        const c = msgs[i].content;
        if (typeof c === 'string') userText = c;
        else if (Array.isArray(c)) {
          userText = c.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join(' ');
        }
        break;
      }
    }
    const score = scoreTaskComplexity(userText, bodyStr.length);
    return { score, tier: suggestTier(score), reason: 'complexity score ' + score + '/10' };
  } catch (e) { return { score: 5, tier: 'mid', reason: 'parse error' }; }
}

module.exports = { scoreTaskComplexity, suggestTier, recommendRoute };
