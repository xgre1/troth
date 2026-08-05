// SPDX-License-Identifier: AGPL-3.0-only
// Gemma 4 artifact patterns — compiled once at startup
const ARTIFACT_PATTERNS = [
  /EOF`?<\|?tool_call\|?>[\s\S]*$/m,
  /<\|tool_call\|?>[\s\S]*$/m,
  /<\|tool_response\|?>[\s\S]*$/m,
  /<tool_call\|>[\s\S]*$/m,
  /<\|unused\d+\|>[\s\S]*$/m,
  /<turn\|>\s*$/m,
  /\|>response:[a-zA-Z0-9]+\{value:[\s\S]*$/m,
];

function cleanText(text) {
  if (!text) return { text, cleaned: false };

  let result = text;
  let cleaned = false;

  // Remove Gemma artifacts
  for (const pattern of ARTIFACT_PATTERNS) {
    const before = result;
    result = result.replace(pattern, '');
    if (result !== before) cleaned = true;
  }

  // Fix incomplete code blocks (odd number of ```)
  const backtickCount = (result.match(/```/g) || []).length;
  if (backtickCount % 2 !== 0) {
    result += '\n```';
    cleaned = true;
  }

  // Clean whitespace issues
  const before = result;
  result = result
    .replace(/\n{4,}/g, '\n\n\n')  // Max 2 blank lines
    .replace(/[ \t]+\n/g, '\n');    // Trailing whitespace
  if (result !== before) cleaned = true;

  return { text: result, cleaned };
}

function cleanResponse(bodyStr) {
  try {
    const data = JSON.parse(bodyStr);
    let totalCleaned = 0;

    // Anthropic format
    if (data.content && Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text' && block.text) {
          const { text, cleaned } = cleanText(block.text);
          block.text = text;
          if (cleaned) totalCleaned++;
        }
      }
    }

    // OpenAI format
    if (data.choices && Array.isArray(data.choices)) {
      for (const choice of data.choices) {
        if (choice.message?.content) {
          const { text, cleaned } = cleanText(choice.message.content);
          choice.message.content = text;
          if (cleaned) totalCleaned++;
        }
      }
    }

    return { body: JSON.stringify(data), cleaned: totalCleaned };
  } catch (e) {
    return { body: bodyStr, cleaned: 0 };
  }
}

module.exports = { cleanResponse, cleanText };
