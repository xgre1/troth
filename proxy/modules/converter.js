// SPDX-License-Identifier: AGPL-3.0-only
// Anthropic ↔ OpenAI format converter.
//
// Claude Code sends requests in Anthropic format. DeepSeek,
// OpenRouter, and local models all speak OpenAI format. This module
// translates between them so any OpenAI-compatible provider can be
// used as a drop-in backend.
//
// Anthropic format:
//   { model, system, messages: [{role, content: [{type, text/tool_use/tool_result}]}], tools: [{name, input_schema}] }
//
// OpenAI format:
//   { model, messages: [{role, content/tool_calls}], tools: [{type:"function", function:{name, parameters}}] }

// OpenAI tool names: ^[a-zA-Z0-9_-]{1,64}$. Anthropic is more permissive
// (dots, slashes, longer names). Sanitize on the way out so non-Anthropic
// providers don't 400 on legal-for-Anthropic tool names.
function sanitizeToolName(name) {
  if (!name) return name;
  var out = String(name).replace(/[^a-zA-Z0-9_-]/g, "_");
  if (out.length > 64) out = out.slice(0, 64);
  return out;
}

// Truncate at codepoint boundary, not UTF-16 surrogate split. Bumped from
// the legacy 500 to 4096: Claude Code's Bash/Edit/Write tool descriptions
// exceed 500 chars and the agent loses critical "when to use" guidance
// when they get cut. Many providers accept far more (OpenAI's docs allow
// 1024 chars officially but most providers tolerate more in practice).
function truncDesc(s, max) {
  if (!s) return "";
  var cap = max || 4096;
  var arr = Array.from(s);
  if (arr.length <= cap) return s;
  return arr.slice(0, cap).join("");
}

function anthropicToOpenAI(bodyStr, opts) {
  opts = opts || {};
  var data;
  try { data = JSON.parse(bodyStr); }
  catch (e) { return null; }

  var messages = [];

  // System prompt → system message
  if (data.system) {
    var sysText = "";
    if (typeof data.system === "string") {
      sysText = data.system;
    } else if (Array.isArray(data.system)) {
      sysText = data.system.map(function(b) {
        return (b && b.text) ? b.text : (typeof b === "string" ? b : "");
      }).join("\n\n");
    }
    if (sysText) messages.push({ role: "system", content: sysText });
  }

  // Convert messages
  for (var i = 0; i < (data.messages || []).length; i++) {
    var msg = data.messages[i];
    var role = msg.role === "assistant" ? "assistant" : "user";

    if (typeof msg.content === "string") {
      messages.push({ role: role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) continue;

    // Separate text, tool_use, and tool_result blocks
    var textParts = [];
    var toolCalls = [];
    var toolResults = [];

    for (var j = 0; j < msg.content.length; j++) {
      var block = msg.content[j];
      if (!block || !block.type) continue;

      if (block.type === "text" && block.text) {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id || ("call_" + Date.now() + "_" + j),
          type: "function",
          function: {
            name: sanitizeToolName(block.name),
            arguments: JSON.stringify(block.input || {})
          }
        });
      } else if (block.type === "thinking" && block.thinking) {
        // Convert thinking to prefixed text so OpenAI models see reasoning
        textParts.push("[reasoning]\n" + block.thinking + "\n[/reasoning]");
      } else if (block.type === "compaction") {
        // Convert compaction summary to plain text
        if (block.content) textParts.push(block.content);
        else if (block.text) textParts.push(block.text);
      } else if (block.type === "redacted_thinking") {
        // Strip entirely — encrypted Anthropic data, useless for other models
        continue;
      } else if (block.type === "tool_result") {
        var resultText = "";
        if (typeof block.content === "string") {
          resultText = block.content;
        } else if (Array.isArray(block.content)) {
          // B1: tool_result content can include text + image + document
          // blocks. OpenAI tool messages typically expect a string. Pass
          // text through and emit a placeholder for non-text blocks so the
          // agent at least KNOWS something visual/structured was returned
          // (instead of silently dropping the entire response).
          resultText = block.content
            .map(function(b) {
              if (!b || !b.type) return "";
              if (b.type === "text") return b.text || "";
              if (b.type === "image") {
                var mt = (b.source && b.source.media_type) || "unknown";
                return "[image:" + mt + " (binary content omitted in OpenAI bridge)]";
              }
              if (b.type === "document") return "[document (binary content omitted in OpenAI bridge)]";
              return "";
            })
            .filter(function(s) { return s.length > 0; })
            .join("\n");
        }
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id || "",
          content: resultText
        });
      }
    }

    // Emit assistant message with tool_calls if present
    if (role === "assistant") {
      var assistantMsg = {};
      assistantMsg.role = "assistant";
      if (textParts.length) assistantMsg.content = textParts.join("\n");
      else assistantMsg.content = null;
      if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
      messages.push(assistantMsg);
    } else {
      // User message — emit text first, then tool results as separate messages
      if (textParts.length) {
        messages.push({ role: "user", content: textParts.join("\n") });
      }
      for (var k = 0; k < toolResults.length; k++) {
        messages.push(toolResults[k]);
      }
      // If user message had neither text nor tool results (unusual), emit empty
      if (!textParts.length && !toolResults.length) {
        messages.push({ role: "user", content: "" });
      }
    }
  }

  // Convert tools
  var tools = null;
  if (data.tools && data.tools.length) {
    tools = [];
    for (var t = 0; t < data.tools.length; t++) {
      var tool = data.tools[t];
      // Filter out troth MCP tools — they're handled locally
      // Filter ALL MCP tools — handled locally by Claude Code
      if (tool.name && tool.name.startsWith("mcp__")) continue;
      if (tool.name && tool.name.startsWith("troth_")) continue;
      // B3 + B4: sanitize tool name (OpenAI charset/length rules) + raise
      // description cap to 4096 with codepoint-safe truncation. Without
      // these, custom plugin tool names with `.` or `:` 400'd, and Bash
      // tool's 2KB description got cut at 500 chars losing usage guidance.
      tools.push({
        type: "function",
        function: {
          name: sanitizeToolName(tool.name),
          description: truncDesc(tool.description, 4096),
          parameters: tool.input_schema || { type: "object", properties: {} }
        }
      });
    }
    if (tools.length === 0) tools = null;
  }

  var result = {
    model: opts.model || data.model || "default",
    messages: messages,
    max_tokens: data.max_tokens || 16384,
    stream: false
  };
  if (tools) result.tools = tools;
  if (opts.temperature !== undefined) result.temperature = opts.temperature;

  return result;
}

// Convert OpenAI response back to Anthropic format
function openAIToAnthropic(responseStr, model) {
  var data;
  try { data = JSON.parse(responseStr); }
  catch (e) { return null; }

  // Handle error responses
  if (data.error) return null;

  var choice = (data.choices || [])[0];
  if (!choice) return null;

  var content = [];
  var msg = choice.message || {};

  // Text content.
  //
  // Thinking-model leak guard. Qwen3.x / DeepSeek-R1 / GPT-oss
  // emit chain-of-thought in two possible shapes:
  //   (a) msg.reasoning_content — separated by the backend (newer LM Studio /
  //       llama.cpp --reasoning-format deepseek). We DROP this; the agent
  //       only wants the final answer.
  //   (b) msg.content with inline <think>…</think> blocks — older backends
  //       or chat templates that don't split. We strip the blocks; what
  //       remains is the real answer.
  // Without this, the troth CLI's native REPL showed the model's entire
  // analytical scratchpad ("Here's a thinking process… 1. Analyze the
  // User's Request…") as the user-facing response and tool calls never
  // fired because the model never reached the act phase.
  function stripThinkBlocks(s) {
    if (typeof s !== "string" || !s) return s;
    var out = s.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "");
    // Unterminated <think> (decoded was cut off mid-thought). Drop everything
    // from the opener onward — emitting half a chain-of-thought is worse
    // than emitting nothing.
    var openIdx = out.search(/<think\b[^>]*>/i);
    if (openIdx >= 0) out = out.slice(0, openIdx);
    return out.trim();
  }
  if (msg.content) {
    var cleanText = stripThinkBlocks(msg.content);
    if (cleanText) content.push({ type: "text", text: cleanText });
  }

  // Tool calls — JSON format (standard)
  if (msg.tool_calls && msg.tool_calls.length) {
    for (var i = 0; i < msg.tool_calls.length; i++) {
      var tc = msg.tool_calls[i];
      var args = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); }
      catch (e) { args = {}; }
      content.push({
        type: "tool_use",
        id: tc.id || ("toolu_ext_" + Date.now() + "_" + i),
        name: tc.function.name,
        input: args
      });
    }
  }

  // XML collapse fallback — DeepSeek on NIM sometimes outputs XML tool
  // calls in text instead of structured tool_calls at high context.
  // Use cleaned text so <invoke> tags nested inside a model's <think>
  // scratchpad don't get misread as real tool calls.
  var scanText = stripThinkBlocks(msg.content || "");
  if (!msg.tool_calls && scanText && scanText.indexOf("<invoke") !== -1) {
    var invokeRe = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
    var invokeMatch;
    while ((invokeMatch = invokeRe.exec(scanText)) !== null) {
      var fnName = invokeMatch[1];
      var fnBody = invokeMatch[2];
      var fnArgs = {};
      var paramRe = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
      var paramMatch;
      while ((paramMatch = paramRe.exec(fnBody)) !== null) {
        fnArgs[paramMatch[1]] = paramMatch[2];
      }
      content.push({
        type: "tool_use",
        id: "toolu_xml_" + Date.now() + "_" + content.length,
        name: fnName,
        input: fnArgs
      });
    }
    if (content.length > 1 && content[0].type === "text") {
      content[0].text = content[0].text.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "").trim();
      if (!content[0].text) content.shift();
    }
  }

  if (content.length === 0) return null;

  // Determine stop reason
  var stopReason = "end_turn";
  if (choice.finish_reason === "length") stopReason = "max_tokens";
  if (content.some(function(c) { return c.type === "tool_use"; })) stopReason = "tool_use";

  var usage = data.usage || {};

  return JSON.stringify({
    id: data.id || ("msg_ext_" + Date.now()),
    type: "message",
    role: "assistant",
    content: content,
    model: model || data.model || "unknown",
    stop_reason: stopReason,
    stop_sequence: null,
    usage: (function () {
      // OpenAI-shape providers report implicit prefix-cache hits in
      // usage.prompt_tokens_details.cached_tokens. Map it to Anthropic's
      // cache_read_input_tokens so the client (Claude Code) and cost.js can SEE
      // and bill the cached portion at the ~10x-cheaper rate. Dropping it made
      // every cache hit invisible and over-reported cost on these providers.
      var u = {
        input_tokens: usage.prompt_tokens || 0,
        output_tokens: usage.completion_tokens || 0
      };
      var cached = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
      if (cached) u.cache_read_input_tokens = cached;
      return u;
    })()
  });
}

module.exports = { anthropicToOpenAI, openAIToAnthropic };
