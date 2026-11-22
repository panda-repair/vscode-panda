const { downloadAndUnzipVSCode, runTests } = require("@vscode/test-electron");
const { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const { frame } = require("../fixture.cjs");

async function main() {
  const executable = process.env.VSCODE_TEST_EXECUTABLE || await downloadAndUnzipVSCode({
    version: "1.122.0", cachePath: process.env.VSCODE_TEST_CACHE || resolve(".vscode-test"),
  });
  const root = mkdtempSync(join(tmpdir(), "panda-"));
  const extension = join(root, "extension");
  const profile = join(root, "user");
  const workspace = join(root, "workspace");
  for (const path of [join(extension, "dist"), join(profile, "User"), workspace, join(root, "extensions")]) {
    mkdirSync(path, { recursive: true });
  }
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
    copyFileSync(join(__dirname, "host.cjs"), join(extension, "host.cjs"));
    writeFileSync(join(workspace, "marker.txt"), "marker from the local fixture");
    mkdirSync(join(workspace, ".vscode"));
    writeFileSync(join(workspace, ".vscode", "settings.json"), JSON.stringify({ "panda.baseUrl": "http://127.0.0.1:1/v1" }));
    writeFileSync(join(profile, "User", "settings.json"), JSON.stringify({
      "panda.baseUrl": endpoint, "telemetry.telemetryLevel": "off", "update.mode": "none",
      "extensions.autoCheckUpdates": false, "extensions.autoUpdate": false, "workbench.enableExperiments": false,
      "chat.disableAIFeatures": false, "security.workspace.trust.enabled": false,
    }));
    await runTests({ vscodeExecutablePath: executable, extensionDevelopmentPath: extension,
      extensionTestsPath: join(extension, "host.cjs"), extensionTestsEnv: { PANDA_FIXTURE_ENDPOINT: endpoint },
      launchArgs: [workspace, "--user-data-dir=" + profile, "--extensions-dir=" + join(root, "extensions"),
        "--disable-extensions", "--disable-gpu", "--no-sandbox", "--use-inmemory-secretstorage", "--use-mock-keychain",
        "--disable-telemetry", "--disable-updates", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes",
        "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-crash-reporter",
        "--proxy-server=http://127.0.0.1:1", "--proxy-bypass-list=localhost;127.0.0.1;[::1]"],
    });
    assert.ok(gets >= 6);
    assert.equal(posts, 4);
    assert.equal(new Set(keys).size, 4);
    assert.deepEqual(roles, [["user"], ["user", "assistant", "tool"],
      ["system", "user"], ["system", "user", "assistant", "tool"]]);
    console.log("Panda integration passed on stock VS Code 1.122.0 (" + gets + " catalog GETs, " + posts + " chat POSTs).");
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
