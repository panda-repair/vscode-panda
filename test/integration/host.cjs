const vscode = require("vscode");
const { createHash } = require("node:crypto");
const assert = require("node:assert/strict");

async function select(expected) {
  const deadline = Date.now() + 10_000;
  let result;
  do {
    result = await vscode.lm.selectChatModels({ vendor: "panda" });
    if (JSON.stringify(result.map(row => row.id).sort()) === JSON.stringify(expected)) return result;
    await new Promise(resolve => setTimeout(resolve, 75));
  } while (Date.now() < deadline);
  assert.deepEqual(result.map(row => row.id).sort(), expected);
}

exports.run = async () => {
  const expected = process.env.PANDA_EXPECTED_VERSION;
  if (expected && expected !== "stable") assert.equal(vscode.version, expected);
  const [major, minor] = vscode.version.split(".").map(Number);
  assert.ok(major > 1 || major === 1 && minor >= 127);
  require("node:fs").writeFileSync(require("node:path").join(process.env.PANDA_FIXTURE_SYNC, "host-version"), vscode.version);
  const { secrets, provider, observer } = await vscode.extensions.getExtension("panda-repair.panda").activate();
  if (process.env.PANDA_FIXTURE_CASE === "proxy-407") {
    return require("./proxy-host.cjs").verifyPac407(secrets, select);
  }
  const endpoint = process.env.PANDA_FIXTURE_ENDPOINT;
  assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  const slot = "panda.apiKey." + createHash("sha256").update(endpoint).digest("hex");
  await select([]);
  await secrets.store(slot, "pnd_it_integration_a");
  const rows = await select(["auto:cost", "panel:panda-quality"]);
  const model = rows.find(row => row.id === "auto:cost");
  assert.equal(model.name, "Panda Auto · Cost");
  assert.equal(model.maxInputTokens, 241616);
  assert.equal(await model.countTokens("hello"), 2);
  const cancellation = new vscode.CancellationTokenSource();
  const timer = setTimeout(() => cancellation.cancel(), 15_000);
  try {
    const tools = [{ name: "read_fixture", description: "Read the test marker.",
      inputSchema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } }];
    async function roundTrip(messages, send) {
      messages.push(vscode.LanguageModelChatMessage.User("Read marker.txt"));
      const parts = await send(messages, { tools, toolMode: vscode.LanguageModelChatToolMode.Required });
      const calls = parts.filter(p => p instanceof vscode.LanguageModelToolCallPart);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].name, "read_fixture");
      assert.deepEqual(calls[0].input, { file: "marker.txt" });
      const file = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, "marker.txt");
      const marker = Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8");
      messages.push(vscode.LanguageModelChatMessage.Assistant(parts), vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelToolResultPart(calls[0].callId, [new vscode.LanguageModelTextPart(marker)])]));
      const result = await send(messages, { tools, toolMode: vscode.LanguageModelChatToolMode.Auto });
      assert.equal(result.map(p => p.value).join(""), marker);
    }
    await roundTrip([], async (history, options) => {
      const result = await model.sendRequest(history, options, cancellation.token);
      return Array.fromAsync(result.stream);
    });
    // A native agent can deliver instructions to a stable provider. Stable
    // extension callers cannot originate that role through model.sendRequest.
    const roles = vscode.LanguageModelChatMessageRole;
    const system = Object.keys(roles).map(Number).find(role => roles[role] === "System");
    assert.ok(Number.isInteger(system));
    await roundTrip([{ role: system, content: [new vscode.LanguageModelTextPart("Use the file tool.")] }],
      async (history, options) => {
        const parts = [];
        await provider.provideLanguageModelChatResponse(model, history, { ...options, modelOptions: {} },
          { report: part => parts.push(part) }, cancellation.token);
        return parts;
      });
  } finally { clearTimeout(timer); cancellation.dispose(); }
  await require("./review-host.cjs").run(model, observer);
  await secrets.store(slot, "pnd_it_integration_b");
  await select(["auto"]);
  await secrets.delete(slot);
  await select([]);
  await require("./proxy-host.cjs").verifyProxy(secrets, select, provider);
};
