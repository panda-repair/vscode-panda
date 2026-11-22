const http = require("node:http");
const { once } = require("node:events");

async function listen(handler) {
  const server = http.createServer(async (req, res) => {
    try { await handler(req, res); } catch (error) { res.destroy(error); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { endpoint: "http://127.0.0.1:" + server.address().port + "/v1",
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

function json(res, payload, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const frame = (delta, finish_reason = null) => "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const signal = () => new AbortController().signal;

class Text { constructor(value) { this.value = value; } }
class Data { constructor(data, mimeType) { Object.assign(this, { data, mimeType }); } }
class ToolCall { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class ToolResult { constructor(callId, content) { Object.assign(this, { callId, content }); } }
const host = { LanguageModelTextPart: Text, LanguageModelDataPart: Data, LanguageModelToolCallPart: ToolCall, LanguageModelToolResultPart: ToolResult,
  LanguageModelChatMessageRole: { User: 1, Assistant: 2, 1: "User", 2: "Assistant", 3: "System" },
  LanguageModelChatToolMode: { Auto: 1, Required: 2 } };

module.exports = { listen, json, frame, pause, signal, Text, Data, ToolCall, ToolResult, host };
