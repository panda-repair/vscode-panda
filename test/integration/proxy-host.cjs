const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const vscode = require("vscode");

exports.verifyProxy = async function verifyProxy(secrets, select) {
  const fixture = JSON.parse(process.env.PANDA_PROXY_FIXTURE);
  const global = vscode.ConfigurationTarget.Global;
  const http = vscode.workspace.getConfiguration("http");
  const set = (name, value) => http.update(name, value, global);
  const selectAt = async endpoint => {
    await vscode.workspace.getConfiguration("panda").update("baseUrl", endpoint, global);
    const slot = "panda.apiKey." + createHash("sha256").update(endpoint).digest("hex");
    await secrets.store(slot, "pnd_it_proxy_fixture");
    return (await select(["auto:cost"]))[0];
  };
  const ask = async (model, text) => {
    const cancel = new vscode.CancellationTokenSource();
    const timer = setTimeout(() => cancel.cancel(), 6000);
    try {
      const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(text)], {}, cancel.token);
      let result = ""; for await (const text of response.text) result += text; return result;
    } finally { clearTimeout(timer); cancel.dispose(); }
  };
  await set("proxySupport", "override");
  await set("proxy", fixture.httpProxy);
  const model = await selectAt(fixture.endpoint);
  assert.equal(await ask(model, "fixed proxy"), "tunnel answer");
  await set("proxy", fixture.httpsProxy); await set("proxyStrictSSL", true);
  await assert.rejects(ask(model, "strict untrusted HTTPS proxy"), /connection/);
  await set("proxyStrictSSL", false);
  assert.equal(await ask(model, "HTTPS proxy only"), "tunnel answer");
  await set("proxy", undefined); await set("proxyStrictSSL", true);
  process.env.HTTPS_PROXY = fixture.httpProxy;
  assert.equal(await ask(model, "environment proxy"), "tunnel answer");
  delete process.env.HTTPS_PROXY;
  assert.equal(await ask(model, "system proxy"), "tunnel answer");
  process.env.HTTPS_PROXY = fixture.httpProxy; process.env.NO_PROXY = "localhost.";
  const direct = await selectAt(fixture.bypass);
  assert.equal(await ask(direct, "bypass proxy"), "tunnel answer");
};
