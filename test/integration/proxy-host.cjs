const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const vscode = require("vscode");

exports.verifyProxy = async function verifyProxy(secrets, select, provider) {
  const fixture = JSON.parse(process.env.PANDA_PROXY_FIXTURE);
  const global = vscode.ConfigurationTarget.Global;
  const http = vscode.workspace.getConfiguration("http");
  const set = (name, value) => http.update(name, value, global);
  const setEndpoint = async endpoint => {
    await vscode.workspace.getConfiguration("panda").update("baseUrl", endpoint, global);
    const slot = "panda.apiKey." + createHash("sha256").update(endpoint).digest("hex");
    await secrets.store(slot, "pnd_it_proxy_fixture");
  };
  const selectAt = async endpoint => {
    await setEndpoint(endpoint);
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
  await set("proxyStrictSSL", false);
  await set("proxyAuthorization", "Bearer wrong-test-proxy");
  await assert.rejects(ask(model, "PAC rejects the proxy credential"), {
    message: "The network proxy requires authentication. Check the proxy address and credentials.",
  });
  await set("proxyAuthorization", fixture.requiredAuth);
  assert.equal(await ask(model, "HTTPS PAC proxy"), "tunnel answer");
  await set("proxyStrictSSL", true);
  await assert.rejects(ask(model, "PAC rejects the untrusted proxy CA"), /connection/);
  const office = await selectAt(fixture.office);
  assert.equal(await ask(office, "HTTP PAC proxy"), "tunnel answer");
  await set("proxyStrictSSL", false);
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "1");
  await setEndpoint(fixture.untrusted);
  const cancel = new vscode.CancellationTokenSource();
  try {
    await assert.rejects(provider.provideLanguageModelChatInformation({ silent: true }, cancel.token), /connection/);
  } finally { cancel.dispose(); }
  const direct = await selectAt(fixture.bypass);
  assert.equal(await ask(direct, "PAC DIRECT"), "tunnel answer");
  const offHostStatus = await new Promise((resolve, reject) => {
    // A mistaken DIRECT route must fail locally before DNS or an origin connection.
    const req = require("https").get("https://panda-unmatched.invalid/", {
      signal: AbortSignal.timeout(5000), lookup: (_host, _options, callback) => callback(new Error("Unexpected direct lookup")),
    }, response => { response.resume(); resolve(response.statusCode); });
    req.on("error", reject);
  });
  assert.equal(offHostStatus, 403);
  process.env.HTTPS_PROXY = fixture.httpProxy; process.env.NO_PROXY = "localhost.";
  assert.equal(await ask(direct, "bypass proxy"), "tunnel answer");
};
