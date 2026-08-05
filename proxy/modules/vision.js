// SPDX-License-Identifier: AGPL-3.0-only
// Vision-aware tool_result augmentation.
//
// Opus 4.7 coordinate-system note (P3.4):
// Earlier Claude models returned bounding-box coordinates normalized to [0,1]
// relative to the input image. Opus 4.7 switched to 1:1 pixel coordinates of
// the input image as-is, removing the need for any rescaling by clients.
// troth does not intercept or transform coordinate values in responses —
// tool_use and tool_result blocks pass through unchanged, so 4.7's pixel
// coordinates reach the client exactly as the model emits them. No action
// required; this comment exists so future edits don't introduce a transform.

//
// The problem this fixes:
//
// Claude Code can spawn Playwright via Bash, take screenshots, and
// run UI tests. The test reports text output ("3 passed, 1 failed")
// back to the agent. But the assistant model (Sonnet, Gemini, ...)
// never actually SEES the screenshot — only the text. So the agent
// can't tell whether the rendered UI is correct, only whether the
// text assertions passed. Half the value of UI tests is lost in
// that gap.
//
// Gemini 3 is natively multimodal. It can look at images and reason
// about them. This module exploits that at the proxy layer:
//
//   1. When a request from Claude Code arrives, scan every tool_result
//      block in the message history for file paths that point to
//      images on disk (.png / .jpg / .jpeg / .webp / .gif).
//   2. For each unique image found, call Gemini Flash with the image
//      and a contextual prompt asking for a visual analysis.
//   3. Augment the tool_result content with the analysis text.
//   4. Forward the augmented request to the agent's main model.
//
// The agent now sees, alongside the original test output:
//   "[troth vision] login-screen.png: The login form is rendered
//   with a misaligned submit button overflowing the container.
//   The 'Forgot password?' link is present in the bottom-right
//   as expected. Background gradient is correct. No console errors
//   visible in the screenshot."
//
// And it can act on what it actually sees. This is a real Gemini
// moat — every other Claude Code proxy that routes to Sonnet/Opus
// loses this capability because those models don't see images
// inside tool_result content blocks.
//
// Cost / latency note: each augmented tool_result triggers one
// Gemini Flash call per image (max 3 per result, configurable).
// Flash is fast and cheap, runs synchronously in the request path.
// The user opts in via the dashboard module toggle (default:
// enabled when running -g, no-op for local backends since vision
// requires Gemini).

const fs = require('fs');
const path = require('path');
const { analyzeImage } = require('./router');

// File extensions we'll try to interpret as images. Conservative —
// only the formats Gemini's vision endpoint supports cleanly.
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

// Cap how many images we analyze per tool_result so a single test
// run that produces 50 screenshots doesn't blow up cost.
const MAX_IMAGES_PER_RESULT = 3;

// Idempotency marker so re-augmenting the same tool_result is a no-op.
// Important because Claude Code re-sends the full message history on
// every turn — without this, we'd vision-analyze the same screenshots
// over and over.
const VISION_MARKER = '[troth vision]';

// Match anything that looks like a file path with an image extension.
// Captures both quoted and unquoted paths, absolute and relative.
const PATH_REGEX = /(?:^|[\s'"`(\[:,>=])((?:\/|\.\/|[a-zA-Z]:[\\/])?[^\s'"`<>(){}|]*?\.(?:png|jpg|jpeg|webp|gif))(?:[\s'"`)\]:,;]|$)/gi;

function findImagePaths(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const found = new Set();
  let m;
  PATH_REGEX.lastIndex = 0;
  while ((m = PATH_REGEX.exec(text)) !== null) {
    let p = m[1];
    if (!p) continue;
    p = p.replace(/^[\s'"`(\[<]+|[\s'"`)\]>,.;:!?]+$/g, '');
    if (p.length === 0) continue;
    if (!path.isAbsolute(p)) {
      try { p = path.resolve(process.cwd(), p); }
      catch (e) { continue; }
    }
    try {
      const st = fs.statSync(p);
      if (st.isFile()) found.add(p);
    } catch (e) { /* not a real file, skip */ }
  }
  return Array.from(found);
}

const DEFAULT_VISION_PROMPT =
  "This is a UI screenshot from a test that a coding agent just ran. " +
  "In 3-5 sentences, describe what you see: what state is the UI in, " +
  "are there any visible bugs (broken layout, overflowing elements, " +
  "missing content, error messages, broken styling, blank areas), " +
  "and does the rendered output look like the test succeeded or failed " +
  "based on visual evidence alone? Be specific about element positions " +
  "and any text you can read in the image.";

// Walk the messages array, find tool_result blocks, scan their text
// content for image paths, run vision analysis, and append the
// analysis to the tool_result content. Returns the (possibly modified)
// body string. Best-effort: any failure leaves the original body
// unchanged.
async function augmentToolResults(bodyStr) {
  let data;
  try { data = JSON.parse(bodyStr); }
  catch (e) { return bodyStr; }

  if (!data.messages || !Array.isArray(data.messages)) return bodyStr;

  let modified = false;
  let totalImagesAnalyzed = 0;

  for (const msg of data.messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue;

      let resultText = '';
      if (typeof block.content === 'string') {
        resultText = block.content;
      } else if (Array.isArray(block.content)) {
        for (const sub of block.content) {
          if (sub && sub.type === 'text' && typeof sub.text === 'string') {
            resultText += sub.text + '\n';
          }
        }
      }

      if (resultText.includes(VISION_MARKER)) continue;

      const imagePaths = findImagePaths(resultText);
      if (imagePaths.length === 0) continue;

      const toAnalyze = imagePaths.slice(0, MAX_IMAGES_PER_RESULT);

      const analyses = await Promise.all(toAnalyze.map(async (imgPath) => {
        try {
          const text = await analyzeImage(imgPath, DEFAULT_VISION_PROMPT);
          if (!text) return null;
          const trimmed = text.length > 600 ? text.slice(0, 600) + '...' : text;
          return { path: imgPath, text: trimmed };
        } catch (e) {
          return null;
        }
      }));

      const valid = analyses.filter(Boolean);
      if (valid.length === 0) continue;

      const lines = [];
      lines.push('');
      lines.push(VISION_MARKER + ' visual analysis of ' + valid.length + ' screenshot(s):');
      for (const a of valid) {
        lines.push('  ' + path.basename(a.path) + ':');
        lines.push('    ' + a.text.split('\n').join('\n    '));
      }
      const augmentation = lines.join('\n');

      if (typeof block.content === 'string') {
        block.content = block.content + augmentation;
      } else if (Array.isArray(block.content)) {
        let appended = false;
        for (let i = block.content.length - 1; i >= 0; i--) {
          if (block.content[i] && block.content[i].type === 'text') {
            block.content[i].text = (block.content[i].text || '') + augmentation;
            appended = true;
            break;
          }
        }
        if (!appended) {
          block.content.push({ type: 'text', text: augmentation });
        }
      }

      modified = true;
      totalImagesAnalyzed += valid.length;
    }
  }

  if (modified) {
    console.log('[vision] augmented ' + totalImagesAnalyzed + ' screenshot(s)');
    return JSON.stringify(data);
  }
  return bodyStr;
}

module.exports = { augmentToolResults, findImagePaths };
