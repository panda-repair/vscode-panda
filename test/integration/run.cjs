const { downloadAndUnzipVSCode, runTests } = require("@vscode/test-electron");
const { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const { frame } = require("../fixture.cjs");
const { reviewFixture } = require("./review-fixture.cjs");
const { proxyFixture } = require("../proxy-fixture.cjs");

async function main() {
  const version = process.env.VSCODE_TEST_VERSION || "1.127.0";
  const executable = process.env.VSCODE_TEST_EXECUTABLE || await downloadAndUnzipVSCode({
    version, cachePath: process.env.VSCODE_TEST_CACHE || resolve(".vscode-test"),
  });
  // Short profile paths also fit macOS's 103-byte Unix-domain socket limit.
  const root = mkdtempSync(join(tmpdir(), "p"));
  const extension = join(root, "extension");
  const profile = join(root, "u");
  const workspace = join(root, "workspace");
  for (const path of [join(extension, "dist"), join(profile, "User"), workspace, join(root, "extensions")]) {
    mkdirSync(path, { recursive: true });
  }
  const sync = join(root, "sync"); mkdirSync(sync);
  const probes = reviewFixture(sync);
  const network = await proxyFixture(join(root, "tls"));
  const issues = [];
  let gets = 0, posts = 0;
  const roles = [], keys = [];
  const server = http.createServer(async (req, res) => {
    const key = req.headers.authorization;
    const allowed = key === "Bearer pnd_it_integration_a" ? ["auto:cost", "panel:panda-quality"] :
      key === "Bearer pnd_it_integration_b" ? ["auto"] : undefined;
    if (!allowed) { res.writeHead(401).end(); return; }
    if (req.method === "GET" && req.url === "/v1/models") {
      gets++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [...allowed, "unknown-fixture"].map(id => ({ id })) }));
    } else if (req.method === "POST" && req.url === "/v1/chat/completions") {
      posts++;
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      if (body.messages[0]?.content?.startsWith("probe:")) {
        try { await probes.handle(req, res, body, text); }
        catch (error) { issues.push(String(error)); res.destroy(); }
        return;
      }
      if (!(allowed.includes(body.model) && body.stream && body.max_tokens === 16384 && req.headers["idempotency-key"] &&
          body.tools?.[0]?.function?.name === "read_fixture")) {
        res.writeHead(400).end(); return;
      }
      roles.push(body.messages.map(m => m.role));
      keys.push(req.headers["idempotency-key"]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const result = body.messages.find(m => m.role === "tool");
      if (result) {
        const call = body.messages.find(m => m.role === "assistant")?.tool_calls?.[0];
        const correct = call?.id === result.tool_call_id && call.function.name === "read_fixture" &&
          result.content === "marker from the local fixture" && body.tool_choice === "auto";
        res.end(frame({ content: correct ? result.content : "invalid tool result" }, "stop") + "data: [DONE]\n\n");
      } else if (body.tool_choice === "required") {
        res.write(frame({ content: "Reading." }));
        res.write(frame({ tool_calls: [{ index: 0, id: "call_1", function: { name: "read_", arguments: '{"file":' } }] }));
        res.end(frame({ tool_calls: [{ index: 0, function: { name: "fixture", arguments: '"marker.txt"}' } }] }, "tool_calls"));
      } else res.end(frame({ content: "missing required tool" }, "stop"));
    } else res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const endpoint = "http://127.0.0.1:" + server.address().port + "/v1";
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    writeFileSync(join(extension, "package.json"), JSON.stringify({ ...manifest, main: "./test-entry.cjs" }));
    copyFileSync("dist/extension.js", join(extension, "dist", "extension.js"));
    copyFileSync(join(__dirname, "entry.cjs"), join(extension, "test-entry.cjs"));
    for (const name of ["host.cjs", "review-host.cjs", "copilot.cjs", "proxy-host.cjs"]) copyFileSync(join(__dirname, name), join(extension, name));
    writeFileSync(join(workspace, "marker.txt"), "marker from the local fixture");
    mkdirSync(join(workspace, ".vscode"));
    writeFileSync(join(workspace, ".vscode", "settings.json"), JSON.stringify({ "panda.baseUrl": "http://127.0.0.1:1/v1" }));
    writeFileSync(join(profile, "User", "settings.json"), JSON.stringify({
      "panda.baseUrl": endpoint, "telemetry.telemetryLevel": "off", "update.mode": "none",
      "extensions.autoCheckUpdates": false, "extensions.autoUpdate": false, "workbench.enableExperiments": false,
      "chat.disableAIFeatures": false, "security.workspace.trust.enabled": false,
    }));
    await runTests({ vscodeExecutablePath: executable, extensionDevelopmentPath: extension,
      extensionTestsPath: join(extension, "host.cjs"), extensionTestsEnv: { PANDA_FIXTURE_ENDPOINT: endpoint,
        PANDA_FIXTURE_SYNC: sync, PANDA_EXPECTED_VERSION: process.env.VSCODE_TEST_EXECUTABLE ? process.env.VSCODE_TEST_VERSION || "" : version,
        PANDA_PROXY_FIXTURE: JSON.stringify({ endpoint: network.endpoint, bypass: network.bypass, httpProxy: network.httpProxy,
          httpsProxy: network.httpsProxy, requiredAuth: network.requiredAuth, office: network.office, untrusted: network.untrusted }),
        NODE_EXTRA_CA_CERTS: network.ca, NODE_TLS_REJECT_UNAUTHORIZED: "1", HTTP_PROXY: "", HTTPS_PROXY: "", NO_PROXY: "",
        http_proxy: "", https_proxy: "", no_proxy: "" },
      launchArgs: [workspace, "--user-data-dir=" + profile, "--extensions-dir=" + join(root, "extensions"),
        "--disable-extensions", "--disable-gpu", "--no-sandbox", "--use-inmemory-secretstorage", "--use-mock-keychain",
        "--disable-telemetry", "--disable-updates", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes",
        "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-crash-reporter",
        "--proxy-pac-url=" + network.pacUrl],
    });
    assert.ok(gets >= 6);
    assert.deepEqual(issues, []);
    const proof = probes.verify();
    assert.equal(posts, 4 + proof.posts);
    assert.equal(new Set(keys).size, 4);
    assert.deepEqual(roles, [["user"], ["user", "assistant", "tool"],
      ["system", "user"], ["system", "user", "assistant", "tool"]]);
    const networkPosts = network.requests.filter(req => req.method === "POST");
    assert.deepEqual(networkPosts.map(req => JSON.parse(req.body).messages[0].content),
      ["fixed proxy", "HTTPS proxy only", "environment proxy", "HTTPS PAC proxy", "HTTP PAC proxy", "PAC DIRECT", "bypass proxy"]);
    assert.deepEqual(networkPosts.map(req => req.via), ["http", "https", "http", "https", "http", "direct", "direct"]);
    assert.ok(network.pacReads.length > 0 && network.pacReads.every(req => !req.originAuth && !req.proxyAuth));
    assert.ok(network.rejected.has("panda-unmatched.invalid:443"));
    assert.ok(network.tunnels.some(req => req.requireAuth && !req.accepted));
    for (const kind of ["http", "https"]) {
      assert.ok(network.tunnels.some(req => req.kind === kind && req.requireAuth && req.accepted &&
        req.proxyAuthorization === network.requiredAuth));
    }
    assert.ok(network.requests.every(req => req.trustedOrigin && req.bearer && !req.proxyAuth));
    assert.ok(network.tunnels.every(req => !req.hasOriginAuthorization && !req.leaked));
    assert.ok(network.tunnels.some(req => req.kind === "https"));
    const actualVersion = readFileSync(join(sync, "host-version"), "utf8");
    console.log("Panda integration passed on stock VS Code " + actualVersion + " (" + gets + " catalog GETs, " + posts +
      " chat POSTs; native cancellation closed both sockets; " + proof.replayPosts + " replay-scenario POSTs, " +
      proof.replayAdmissions + " admissions). TLS origin received " + (network.requests.length - networkPosts.length) +
      " catalog GETs and " + networkPosts.length + " chat POSTs via fixed, environment, HTTP/HTTPS PAC and bypass routes.");
  } finally {
    await network.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
