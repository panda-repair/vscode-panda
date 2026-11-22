const { writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { frame, json, pause } = require("../fixture.cjs");
const assert = require("node:assert/strict");

exports.reviewFixture = function reviewFixture(dir) {
  const traces = [], ledger = new Map();
  const mark = label => writeFileSync(join(dir, label), "yes");
  const send = (res, text) => res.writeHead(200, { "content-type": "text/event-stream" }).end(frame({ content: text }, "stop"));
  function replay(res, row) {
    res.setHeader("Idempotency-Replayed", "true");
    res.setHeader("X-Panda-Request-ID", row.id);
    json(res, { error: { code: "mixture_already_" + row.status }, panda: { version: "panda.chat.v1", replay: true,
      run_id: row.id, status: row.status, charge: row.status === "running" ? null :
        { schema_version: "panda.usd-amount.v1", currency: "USD", minor_units: "3" }, held: null } }, 409);
  }
  async function handle(req, res, body, raw) {
    const label = body.messages[0]?.content;
    if (typeof label !== "string" || !label.startsWith("probe:")) return false;
    const key = req.headers["idempotency-key"];
    traces.push({ label, key, raw });
    if (label.startsWith("probe:cancel-")) {
      res.on("close", () => mark(label.slice(6) + "-closed"));
      mark(label.slice(6) + "-received");
      if (label === "probe:cancel-body") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ content: "visible" }));
      }
    } else if (label === "probe:replay") {
      const previous = ledger.get(key);
      if (previous) replay(res, previous);
      else {
        const id = "run-fixture-" + (ledger.size + 1);
        const row = { id, status: "running" }; ledger.set(key, row);
        if (ledger.size === 2) {
          mark("fresh-admitted");
          const deadline = Date.now() + 12000;
          while (!existsSync(join(dir, "release-fresh")) && !res.destroyed && Date.now() < deadline) await pause(20);
        }
        row.status = "completed"; send(res, "answer from " + id);
      }
    } else if (label === "probe:parallel") {
      assert.deepEqual(body.messages.map(m => [m.role, m.content, m.tool_call_id]),
        [["user", label, undefined], ["assistant", null, undefined], ["tool", "first 🐼", "c1"],
          ["tool", "**second**", "c2"], ["user", "between", undefined]]);
      send(res, "parallel accepted");
    } else if (label === "probe:agent") {
      assert.deepEqual(body.messages, [{ role: "user", content: label }]); send(res, "stock Agent accepted");
    } else if (label === "probe:plain markdown") send(res, "data accepted");
    else throw new Error("Unexpected test request");
    return true;
  }
  function verify() {
    const replays = traces.filter(t => t.label === "probe:replay");
    const [original, fresh] = ledger.keys();
    assert.equal(ledger.size, 2);
    assert.deepEqual(replays.map(t => t.key), [original, original, fresh, original, fresh, original]);
    assert.equal(new Set(replays.map(t => t.raw)).size, 1);
    for (const phase of ["cancel-headers", "cancel-body"])
      assert.equal(traces.filter(row => row.label === "probe:" + phase).length, 1);
    return { posts: traces.length, replayPosts: replays.length, replayAdmissions: ledger.size };
  }
  return { handle, verify };
};
