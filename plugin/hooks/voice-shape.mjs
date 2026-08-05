#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// voice-shape — per-turn output-shaping for the voice path.
//
// When the agent is invoked from the troth voice app, the app runtime sets
// TROTH_VOICE_MODE=1 on the spawned `claude` CLI. SessionStart already
// injects a one-shot greeting directive; that fires once per session and
// has nothing to do with HOW subsequent turns are shaped.
//
// This hook injects a per-turn directive that asks claude to PRODUCE TTS-
// ready output at the source — short, partner-style, no markdown / no
// paths / no lists / matched user language — instead of relying on the
// post-claude compactor (app side) to rescue terminal-style
// verbose replies. Voice quality improves; compactor latency drops because
// it has less to do.
//
// Bounded: only fires when TROTH_VOICE_MODE=1. Terminal sessions exit
// with empty allow() and pay near-zero cost (process spawn + immediate
// exit). Multi-user clean — no hardcoded paths, names, or workspaces.

import { readStdinJson, addContext, allow } from './_lib.mjs';

await readStdinJson();

if (process.env.TROTH_VOICE_MODE !== '1') {
  allow();
}

// User's chosen spoken language (set by the app from cfg.voice_language).
// Drives the language-pin directive below so the agent's reply stays in
// the user's primary language even when a single utterance code-switches
// or uses foreign slang ("Άσε με!"). Without this pin, the agent
// language-flips, the compactor mirrors the flip, and the user hears a
// Russian/whatever reply when their primary language is Greek.
const VOICE_LANG = (process.env.TROTH_VOICE_LANGUAGE || '').trim();
const LANG_NAMES = {
  el: 'Greek (Ελληνικά)',
  en: 'English',
  es: 'Spanish (Español)',
  de: 'German (Deutsch)',
  ru: 'Russian (Русский)',
  fr: 'French (Français)',
  it: 'Italian (Italiano)',
};
const langName = LANG_NAMES[VOICE_LANG] || '';
const langDirective = langName
  ? `\n- LANGUAGE PIN: respond in ${langName}. The user's primary spoken language is ${langName}. Even if their utterance contains a foreign phrase, slang, or single word from another language, your reply stays in ${langName}. Do NOT mirror the foreign language.`
  : '';

// IMPORTANT: this directive does NOT ask the agent to shorten its output.
// The chat panel renders the agent's full terminal-style reply (paths,
// code blocks, lists — everything it would write in a real terminal
// session). A separate voice-side compactor (in the app)
// rephrases that reply for TTS. Forcing brevity here would degrade the
// chat panel too — the user reads on screen what the agent produced,
// hears the compactor's short voice version. Two surfaces, same brain.
//
// What this directive DOES enforce: behavior rules that matter
// universally (don't beg for permission, don't emit narration tags, match
// the user's language). Length / format stays as the agent would
// naturally produce it for the user.
addContext(
  '[troth/voice-shape] This turn was spoken into a voice front-end. The ' +
  'user will both READ your full reply in a chat panel AND hear a separate ' +
  'voice-compactor render an abbreviated version of it for TTS. Produce your ' +
  'normal, complete terminal-style answer — paths, code, lists are fine on ' +
  'screen — the compactor handles voice brevity separately.\n\n' +
  'BEHAVIOR RULES (apply this turn, regardless of length/format):' +
  langDirective + '\n' +
  '- TOOL USE — read this carefully. You have the SAME full tool surface ' +
  'as a terminal Claude Code session: built-in Read, Edit, Write, Bash, ' +
  'Grep, Glob, Task, **WebSearch**, **WebFetch**, NotebookEdit, plus the ' +
  'troth MCPs (substrate, memory, hashline, cache, bash, router). USE ' +
  'them. Treat every voice turn like a terminal turn — if the user asks ' +
  'you to "find / search / research / ψάξε / βρες / brainstorm with current ' +
  'data", you SHOULD call WebSearch or WebFetch BEFORE drafting an answer ' +
  'from training memory. Same applies to recall ("τι κάναμε σήμερα" → ' +
  '`troth_dialogue_recent`), to grep/file work, to running commands. ' +
  'Synthesizing from memory when a tool would give you fresher / more ' +
  'specific data is the single biggest voice failure mode. The user spoke ' +
  'the request — that IS your confirmation to invoke tools.\n' +
  '- NEVER ask permission ("should I search?", "θες να ψάξω;", "want me ' +
  'to look?"). Just invoke the right tool and report what you found. If ' +
  'you genuinely lack a tool for the task, say so plainly — but check first ' +
  'before claiming you can\'t.\n' +
  '- For "what did we do / discuss / work on today / recently", prefer ' +
  '`troth_dialogue_recent` (user/agent turns the watcher captured across ' +
  'terminal AND voice surfaces). For older or thematic memory, ' +
  '`troth_recall` / `troth_search_actions`.\n' +
  '- NEVER emit narration markers like [claim] / [question] / [refusal] ' +
  'tags. Plain prose only. The chat panel and the TTS both render your ' +
  'text — markers leak everywhere and confuse both surfaces.\n' +
  '- Never say "as an AI" / "I cannot speak" / "the user asked" — speak as ' +
  'their partner directly.'
);
