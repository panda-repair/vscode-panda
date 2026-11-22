const { subscribe, unsubscribe } = require("node:diagnostics_channel");
const { PandaClient } = require("../out/client");
const conf = JSON.parse(process.env.PANDA_PROXY_FIXTURE);
const client = new PandaClient(() => conf.settings);
const clock = [];
const observe = ({ request }) => clock.push([request.method, request.headersTimeout, request.bodyTimeout]);
subscribe("undici:request:create", observe);
(async () => {
  try {
    const signal = AbortSignal.timeout(5000);
    const selected = await client.list(conf.url, "pnd_it_proxy_fixture", signal);
    let text = "";
    await client.chat(conf.url, "pnd_it_proxy_fixture", { model: "auto:cost", messages: [conf.input || "hi"] },
      signal, part => { text += part.text; });
    console.log(JSON.stringify({ ids: selected.map(m => m.id), text, clock }));
  } catch (error) { console.log(JSON.stringify({ error: error.message, clock })); }
  finally { unsubscribe("undici:request:create", observe); await client.close(); }
})().catch(() => { process.exitCode = 1; });
