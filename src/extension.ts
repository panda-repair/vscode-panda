import * as vscode from "vscode";
import { Access, DEFAULT_ENDPOINT, normalizeEndpoint, secretSlot, validKey } from "./access";
import { PandaClient } from "./client";
import { PandaError } from "./errors";
import { GenerateActions } from "./generate";
import { chatBody, tokenEstimate } from "./messages";
import type { NetworkSettings } from "./transport";

function endpoint() {
  return vscode.workspace.getConfiguration("panda").inspect<string>("baseUrl")?.globalValue ?? DEFAULT_ENDPOINT;
}

function networkSettings(): NetworkSettings {
  const config = vscode.workspace.getConfiguration("http");
  function setting<T>(name: string) {
    const value = config.inspect<T>(name);
    return value?.globalValue ?? value?.defaultValue;
  }
  return { proxy: setting<string>("proxy"), noProxy: setting<string[]>("noProxy"), proxySupport: setting<string>("proxySupport"),
    proxyStrictSSL: setting<boolean>("proxyStrictSSL"), systemCertificates: setting<boolean>("systemCertificates"),
    proxyAuthorization: setting<string>("proxyAuthorization") };
}

function publicError(error: unknown): Error {
  if (error instanceof vscode.CancellationError) return error;
  if (!(error instanceof PandaError)) return new Error("Panda could not complete the operation.");
  if (error.kind === "auth") return vscode.LanguageModelError.NoPermissions(error.message);
  if (error.kind === "blocked") return vscode.LanguageModelError.Blocked(error.message);
  if (error.kind === "model") return vscode.LanguageModelError.NotFound(error.message);
  return new Error(error.message);
}

async function cancellable<T>(token: vscode.CancellationToken, operation: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const abort = () => controller.abort(new vscode.CancellationError());
  const subscription = token.onCancellationRequested(abort);
  try {
    if (token.isCancellationRequested) abort();
    controller.signal.throwIfAborted();
    return await operation(controller.signal);
  } catch (error) { throw publicError(error); }
  finally { subscription.dispose(); }
}

export function activate(context: vscode.ExtensionContext) {
  const client = new PandaClient(networkSettings);
  const access = new Access(context.secrets, endpoint, client);
  const generations = new GenerateActions(access, vscode);
  const updates = new vscode.EventEmitter<void>();
  let management: Promise<boolean> | undefined;

  async function edit(signal: AbortSignal, suppliedToken?: vscode.CancellationToken): Promise<boolean> {
    const identity = await access.identity(signal);
    if (identity.key) {
      const action = await vscode.window.showQuickPick(["Change API key", "Check current key", "Clear API key"], {
        title: "Panda API key", placeHolder: identity.endpoint,
      }, suppliedToken);
      if (!action) return false;
      if (action === "Clear API key") { await access.clear(identity, signal); updates.fire(); return false; }
      if (action === "Check current key") {
        if (!validKey(identity.key)) throw new PandaError("The saved Panda API key is invalid.", "auth");
        const grants = await access.list(identity, signal, true).finally(() => updates.fire());
        void vscode.window.showInformationMessage("Panda key verified. Available models: " + grants.length + ".");
        return true;
      }
    }
    const value = await vscode.window.showInputBox({ title: "Panda API key", prompt: "Set an inference token for " + identity.endpoint,
      password: true, ignoreFocusOut: true, placeHolder: "pnd_it_…",
      validateInput: input => validKey(input.trim()) ? undefined : "Enter an inference token beginning with pnd_it_.",
    }, suppliedToken);
    if (value === undefined) return false;
    await access.set(identity, value, signal);
    updates.fire();
    return true;
  }

  function manage(signal: AbortSignal, token?: vscode.CancellationToken) {
    management ??= edit(signal, token).finally(() => { management = undefined; });
    return management;
  }

  const provider: vscode.LanguageModelChatProvider = {
    onDidChangeLanguageModelChatInformation: updates.event,
    provideLanguageModelChatInformation(options, token) {
      return cancellable(token, async signal => {
        let identity = await access.identity(signal);
        if (!identity.key) {
          if (options.silent || !await manage(signal, token)) return [];
          identity = await access.identity(signal);
        }
        return access.list(identity, signal);
      });
    },
    provideLanguageModelChatResponse(model, messages, options, progress, token) {
      return cancellable(token, async signal => {
        const body = chatBody(model.id, messages, options, vscode);
        await access.chat(model.id, body, signal, part => progress.report("text" in part ?
          new vscode.LanguageModelTextPart(part.text) : new vscode.LanguageModelToolCallPart(part.id, part.name, part.input)),
          (error, wire, operation) => generations.offer(model.id, error, wire, operation));
      });
    },
    async provideTokenCount(_model, input, token) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      return tokenEstimate(input, vscode);
    },
  };

  context.subscriptions.push(updates, generations, { dispose() { access.invalidate(); void client.close(); } },
    vscode.commands.registerCommand("panda.manageApiKey", async () => {
      try { await manage(new AbortController().signal); }
      catch (error) { void vscode.window.showErrorMessage(publicError(error).message); }
    }),
    context.secrets.onDidChange(event => {
      if (event.key.startsWith("panda.apiKey.")) {
        try { if (event.key !== secretSlot(normalizeEndpoint(endpoint()))) return; } catch { /* Also clear the old binding. */ }
        generations.clear(); access.invalidate(); updates.fire();
      }
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("panda.baseUrl")) { generations.clear(); access.invalidate(); updates.fire(); }
    }),
    vscode.lm.registerLanguageModelChatProvider("panda", provider));
}
