// SPDX-License-Identifier: AGPL-3.0-only
// self-statements - what the user has said about themselves, in their words.
//
// A request-shaped question ("recommend a show for tonight", "tips for my
// slow cooker") is answered well only when the reply is built around the
// one thing the user already told us about themselves that bears on it: the
// role they hold ("an aspiring stand-up comedian"), a constraint they live
// by ("trying to eat vegetarian or vegan"), a skill they earned ("a mixology
// class"), a stated liking. These are identity and state, not episodes, so
// they are lifted out of the retrieved statements and listed first, dated,
// each with its receipt. Conservative, first-person only: the assistant
// describing the user is not the user describing themselves.
'use strict';

const STOP = '(?=[.!?,;:]|\\s+(?:and|but|so|who|which|that|because|looking|i)\\b|$)';
const PATTERNS = [
  // role / identity: "I'm an aspiring stand-up comedian", "as a new parent"
  { kind: 'role', re: new RegExp("\\b(?:i am|i'm|as an?)\\s+(?:an?\\s+)?((?:aspiring|new|passionate|avid|amateur|professional|lifelong|dedicated|serious|casual|beginner|experienced|self-taught)\\s+[a-z][a-z \\-]{2,50}?|[a-z][a-z\\-]+(?:\\s+[a-z\\-]+){0,3}?\\s+(?:comedian|writer|teacher|nurse|engineer|developer|designer|student|parent|mom|dad|runner|cyclist|climber|gardener|cook|chef|baker|photographer|musician|artist|painter|knitter|gamer|traveler|traveller|vegan|vegetarian|beginner|enthusiast|fan|collector|hobbyist))" + STOP, 'gi') },
  // constraint / ongoing effort: "I've been trying to eat vegan", "I'm trying to cut down on sugar"
  { kind: 'constraint', re: new RegExp("\\b(?:i(?:'ve| have) been trying to|i(?:'m| am) trying to|i(?:'ve| have) been (?:eating|avoiding|cutting)|i(?:'m| am) (?:allergic to|intolerant to|avoiding)|i (?:can't|cannot|don't|do not) (?:eat|drink|stand|handle|tolerate))\\s+([a-z0-9][^.!?,;:]{3,70}?)" + STOP, 'gi') },
  // skill / background: "I took a mixology class", "I completed a pottery course"
  { kind: 'skill', re: new RegExp("\\b(?:i (?:took|attended|completed|finished|did|signed up for|enrolled in|have taken))\\s+(?:a|an|the|my|some)?\\s*([a-z0-9][^.!?,;:]{3,60}?(?:class|classes|course|courses|workshop|workshops|lesson|lessons|training|certification|degree))\\b", 'gi') },
  // prior effort: "like my lemon poppyseed cake that I made for a colleague"
  { kind: 'effort', re: new RegExp("\\b(?:like|similar to|as with|after) (?:my|the) ([a-z0-9][^.!?,;:]{3,60}?) (?:that|which) i (?:made|baked|built|cooked|wrote|painted|knitted|sewed|brewed|planted|designed)\\b", 'gi') },
  // liking / interest: "I love true crime", "I'm really into board games", "I prefer quiet evenings"
  { kind: 'liking', re: new RegExp("\\b(?:i (?:love|prefer|enjoy|adore|like|really like|can't get enough of)|i(?:'m| am) (?:really |very |particularly |especially )?(?:into|interested in|passionate about|a big fan of|obsessed with|drawn to))\\s+([a-z0-9][^.!?,;:]{3,70}?)" + STOP, 'gi') }
];

// Extract first-person self statements from a dialogue statement. Only the
// user's half is read ("user: ... / asst: ..." or a bare user line).
function extractSelfStatements(text) {
  const raw = String(text || '');
  const cut = raw.indexOf(' / asst:');
  let user = cut >= 0 ? raw.slice(0, cut) : raw;
  user = user.replace(/^\s*(?:\[[^\]]*\]\s*)*user:\s*/i, '');
  if (/^\s*asst:/i.test(user)) return [];
  const out = [];
  const seen = new Set();
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(user))) {
      const what = String(m[1] || '').trim().replace(/[.!?,;:]+$/, '');
      if (what.length < 3 || what.length > 80) continue;
      const key = p.kind + ':' + what.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: p.kind, what });
    }
  }
  return out;
}

module.exports = { extractSelfStatements };
