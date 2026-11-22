const fs = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");

// Run the actual convertToApiChatMessage function from this installation's
// Copilot extension. Isolating the function avoids activating Copilot or signing in.
// The raw input is the user text + cache breakpoint produced by Agent mode.
exports.agentMessage = function agentMessage(vscode, text) {
  const code = fs.readFileSync(join(vscode.env.appRoot, "extensions/copilot/dist/extension.js"), "utf8");
  const sentinel = /new ([\w$]+)\.LanguageModelDataPart\(new TextEncoder\(\)\.encode\("ephemeral"\),([\w$]+)\.CacheControl\)/.exec(code);
  assert.ok(sentinel, "locate Copilot's cache breakpoint conversion in the stock extension");
  const before = code.slice(sentinel.index - 4096, sentinel.index);
  const head = [...before.matchAll(/function [\w$]+\([^)]*\)\{let ([\w$]+)=\[\];/g)].at(-1);
  assert.ok(head);
  const start = sentinel.index - before.length + head.index;
  const last = "return " + head[1] + "}";
  const end = code.indexOf(last, sentinel.index);
  assert.ok(end > start && end - start < 8000);
  const source = code.slice(start, end + last.length);
  const rawName = /([\w$]+)\.Raw\.ChatCompletionContentPartKind\.Text/.exec(source)[1];
  const raw = { ChatRole: { System: 0, User: 1, Assistant: 2, Tool: 3 },
    ChatCompletionContentPartKind: { Image: 0, Text: 1, Opaque: 2, CacheBreakpoint: 3, Document: 4 } };
  const convert = vm.runInNewContext("(" + source + ")", {
    [sentinel[1]]: vscode, [sentinel[2]]: { CacheControl: "cache_control" }, [rawName]: { Raw: raw }, TextEncoder,
  });
  return convert([{ role: raw.ChatRole.User, content: [
    { type: raw.ChatCompletionContentPartKind.Text, text }, { type: raw.ChatCompletionContentPartKind.CacheBreakpoint, cacheType: "ephemeral" },
  ] }]);
};
