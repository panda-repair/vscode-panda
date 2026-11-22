const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join } = require("node:path");
const vscode = require("vscode");
const { agentMessage } = require("./copilot.cjs");

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, label) {
  const deadline = Date.now() + 8000;
  while (!condition()) { if (Date.now() > deadline) throw new Error("Timed out: " + label); await pause(20); }
}
async function invoke(model, messages, token, part) {
  const response = await model.sendRequest(messages, { tools: [{ name: "read", description: "Read a fixture",
    inputSchema: { type: "object", properties: {} } }] }, token);
  let text = ""; for await (const value of response.text) { text += value; part?.(value); } return text;
}
exports.run = async (model, observer) => {
  const dir = process.env.PANDA_FIXTURE_SYNC;
  const user = vscode.LanguageModelChatMessage.User, assistant = vscode.LanguageModelChatMessage.Assistant;
  const T = vscode.LanguageModelTextPart, D = vscode.LanguageModelDataPart;
  const message = agentMessage(vscode, "probe:agent");
  if (vscode.version === "1.127.0") {
    assert.ok(message[0].content.some(p => p instanceof D && p.mimeType === "cache_control" &&
      Buffer.from(p.data).toString("utf8") === "ephemeral"), "stock Agent emitted the cache marker");
  }
  assert.equal(await model.countTokens(message[0]), 3);
  assert.equal(await invoke(model, message), "stock Agent accepted");
  const data = user([D.text("probe:plain ", "text/plain"), D.text("markdown", "text/markdown")]);
  assert.equal(await model.countTokens(data), 5);
  assert.equal(await invoke(model, [data]), "data accepted");
  const call = id => new vscode.LanguageModelToolCallPart(id, "read", {});
  const result = (id, text, mime) => new vscode.LanguageModelToolResultPart(id, [D.text(text, mime)]);
  const parallel = [user("probe:parallel"), assistant([call("c1"), call("c2")]),
    user([result("c1", "first 🐼", "text/plain"), new T("between"), result("c2", "**second**", "text/markdown")])];
  assert.equal(await invoke(model, parallel), "parallel accepted");

  for (const phase of ["cancel-headers", "cancel-body"]) {
    const source = new vscode.CancellationTokenSource();
    let finished, visible = "";
    const pending = invoke(model, [user("probe:" + phase)], source.token, part => { visible += part; })
      .then(value => { finished = { value }; }, error => { finished = { error }; });
    try {
      await until(() => fs.existsSync(join(dir, phase + "-received")), "server accepted " + phase);
      if (phase === "cancel-body") await until(() => visible === "visible", "visible output");
      source.cancel();
      await until(() => finished && fs.existsSync(join(dir, phase + "-closed")), "caller settled and socket closed");
      await pending;
      assert.match(String(finished.error?.name ?? finished.error), /cancel/i);
    } finally { source.cancel(); source.dispose(); }
  }

  const replay = () => invoke(model, [user("probe:replay")]);
  assert.equal(await replay(), "answer from run-fixture-1");
  const denied = () => assert.rejects(replay(), /run-fixture-1.*completed.*USD 0\.03/);
  await denied();
  await until(() => observer.offers.length === 1, "offer for the selected admitted run");
  observer.offers.shift().choose();
  await until(() => fs.existsSync(join(dir, "fresh-admitted")), "explicit paid child opened");
  await denied(); // A late, untagged original arrives while its child is running.
  await until(() => observer.offers.length === 1, "repeat offer for parent");
  observer.offers.shift().choose(); // Reconnect to the same child; never admit another.
  await until(() => observer.offers.some(o => o.message.includes("run-fixture-2")), "verified running child receipt");
  assert.match(observer.offers[0].message, /running/);
  observer.offers.shift().dismiss();
  fs.writeFileSync(join(dir, "release-fresh"), "");
  await until(() => observer.panels.some(p => p.webview.html.includes("answer from run-fixture-2")), "fresh answer in visible Panda panel");
  await denied();
  for (const offer of observer.offers.splice(0)) offer.dismiss();
  for (const panel of observer.panels.splice(0)) panel.dispose();

  const limited = [user("probe:output-limit")];
  let visible = "";
  try { await invoke(model, limited, undefined, part => { visible += part; }); }
  catch (error) { assert.match(error.message, /output token limit/); }
  assert.equal(visible, "The first half");
  await assert.rejects(invoke(model, limited), /run-limited-1.*completed.*USD 0\.03/);
  await until(() => observer.offers.some(o => o.message.includes("run-limited-1")), "paid follow-up offer");
  const offer = observer.offers.find(o => o.message.includes("run-limited-1"));
  assert.ok(offer.message.includes("Choose this action to request this run's follow-up. If Panda already accepted it, you'll see its status and any settled charge."));
  offer.choose();
  const warning = "Panda reached the output limit. This answer is incomplete.";
  await until(() => observer.panels.some(p => p.webview.html.includes(warning)), "truncated answer in visible panel");
  const html = observer.panels.find(p => p.webview.html.includes(warning)).webview.html;
  assert.ok(html.includes("The first half\n\n" + warning));
  assert.doesNotMatch(html, /unfinished_tool|unfinished-id|secret|Tool request:/);
  for (const panel of observer.panels.splice(0)) panel.dispose();
};
