# Panda for VS Code

Use Panda in VS Code Chat with your own Panda inference token. **Choose Panda Mini (`auto:cost`) for fast everyday work.** Only Panda Mini always answers with one model. Panda Mix and Panda Mix Pro run a mix, where two models answer and one combines their answers. VS Code agent mode sends tools, and with tools Panda Auto and Panda Max can run a mix too. A mix can take several minutes before the first text arrives.

## Install and connect

1. In VS Code 1.127.0 or later, install **Panda API** (`panda-repair.panda-api`) from the Extensions view, or run `code --install-extension panda-repair.panda-api`. To install a downloaded VSIX instead, run **Extensions: Install from VSIX…** and select the downloaded `.vsix` file.
2. Run **Panda: Manage API Key** from the Command Palette and paste your `pnd_it_…` inference token into the password field. The extension checks the token with Panda and saves it in VS Code’s SecretStorage.
3. Open Chat’s model picker and select **Panda Mini**. Only Panda models returned by your token’s model list are available. For Business or Enterprise accounts, your administrator controls access through the **Bring Your Own Language Model Key in VS Code** policy.

Use **Panda: Manage API Key** to change, check or clear the key. A silent model lookup with no key returns an empty list. An interactive setup can prompt for the key. The extension caches discovery for the active key and endpoint and checks the selected model’s grant again before each chat request.

## Models

| Model in the picker | ID | What it does | Maximum input tokens |
| --- | --- | --- | ---: |
| Panda Mini | `auto:cost` | One low-cost model, every time. | 241,616 |
| Panda Auto | `auto` | Picks the right model for each request. | 207,616 |
| Panda Mix | `panel:panda` | Two models answer, and one combines their answers. | 207,616 |
| Panda Mix Pro | `panel:panda-quality` | The same mix, with a stronger model combining. | 207,616 |
| Panda Max | `auto:quality` | Panda’s best answer, mixed or single. | 170,616 |

All five accept text and function tools. Each reserves up to 16,384 output tokens. VS Code gets a local estimate of one token per four characters, rounded up. Panda enforces each model’s own request limits. [Model limits](https://panda.repair/products/llm-api#llm-api-model-limits) · [Coding agent guide](https://panda.repair/products/llm-api/coding-agents)

## Waiting for a response

A mix may wait for several answers before the first text arrives. Every model gets ten minutes for headers and ten minutes between response chunks. Cancel in Chat to stop waiting. After submission, cancellation or a lost connection can leave a charge even when VS Code does not receive the answer.

The extension sends each chat request once. VS Code’s chat runtime can retry before it receives the first output. The same endpoint, token and wire request produce the same `Idempotency-Key`, derived from the model, messages, tool declarations, tool choice and output limit. A changed tool result or later conversation turn gets a new key. Retry or Regenerate with an identical request reuses its key. If Panda already accepted it, Panda returns HTTP 409. VS Code shows an error with no saved or fresh answer. The retry adds no charge. Changing the prompt starts a separate request that may incur a charge. To request another generation for that run, select **Generate another answer (may incur a charge)** in its replay notification and read the answer or proposed tool calls in a separate **Panda answer** panel.

Choosing the same run’s action again uses the same generation key, including after reconnecting. The panel displays completed tool calls as text. If Panda reaches the output limit, the panel keeps the text it received and marks the answer incomplete. Closing the panel stops the local request. The notification keeps its request in memory for up to five minutes. Retry the original turn to reopen an expired offer.

## Endpoint

The default API base URL is `https://app.panda.repair/v1`. To use another Panda endpoint, set `panda.baseUrl` in **User Settings**, including the `/v1` path. Each normalized endpoint has its own SecretStorage entry. Changing the endpoint requires a key saved for that endpoint. Workspace settings cannot redirect a saved key. Use HTTPS, or HTTP on loopback for local testing. The extension rejects HTTP redirects.

For corporate networks, set `http.proxy` in VS Code User Settings or set `HTTPS_PROXY` in the environment. The user setting takes precedence. A nonempty `http.noProxy` list controls bypasses, otherwise `NO_PROXY` applies. Without a fixed proxy, VS Code can use its system proxy or PAC configuration. Set `http.proxySupport` to `off` for a direct connection. Local HTTP stays on loopback. On Linux, VS Code can keep using a previously set fixed proxy after you clear `http.proxy`. If Panda can't connect after you change proxy settings, restart VS Code.

Use `http.proxyAuthorization` for a proxy that requires credentials and `http.systemCertificates` to trust corporate certificate authorities. For an HTTPS proxy, `http.proxyStrictSSL` controls verification of the proxy’s certificate, including when VS Code selects it through PAC. The extension verifies the origin’s certificate separately. Both ten-minute timeouts also apply through a proxy.

## Where your data goes

Panda receives the selected model, conversation text, tool definitions, tool-call arguments and tool results. The extension sends the Panda bearer inside the TLS connection to the API and omits it from CONNECT. A corporate gateway that inspects TLS using a CA you trust can read the bearer and the conversation.

In a mix, every model reads the conversation, with your tool descriptions, arguments and results. Without tools, Panda Auto and Panda Max read up to 2,000 characters from the start of your latest user message to pick how to answer.

Panda's privacy policy says it retains billing metadata and does not retain API prompts or responses. It also says which providers process your requests and what they may keep. [What Panda keeps](https://panda.repair/products/llm-api#llm-api-data) · [Panda privacy policy](https://panda.repair/privacy)

## Development

Use Node.js 24 and OpenSSL to run `npm ci`, `npm test` and `npm run test:integration`. The integration runner uses a fresh profile, synthetic keys and a loopback API. It downloads stock VS Code 1.127.0 by default. Set `VSCODE_TEST_VERSION=stable` to test the current stable release, `VSCODE_TEST_EXECUTABLE` to an existing executable for offline use, or `VSCODE_TEST_CACHE` to choose a download cache. On headless Linux use `xvfb-run -a npm run test:integration`.

Build a reproducible VSIX from a clean commit with `TZ=UTC SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)" npm run package`.

MIT License. Copyright (c) 2026 panda-repair.
