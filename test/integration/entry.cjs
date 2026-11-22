const vscode = require("vscode");
const Module = require("node:module");
const { join } = require("node:path");

// The test-only manifest uses this entry. Observe the real provider while still
// registering it with the stock host and using the production bundle unchanged.
exports.activate = context => {
  let provider;
  const lm = Object.create(vscode.lm, { registerLanguageModelChatProvider: { value(vendor, registered) {
    provider = registered;
    return vscode.lm.registerLanguageModelChatProvider(vendor, registered);
  } } });
  const observer = { offers: [], panels: [] };
  const window = Object.create(vscode.window, {
    showWarningMessage: { value(message, ...items) {
      const action = items.find(item => item === "Generate another answer (may incur a charge)");
      if (!action) return vscode.window.showWarningMessage(message, ...items);
      return new Promise(resolve => observer.offers.push({ message, choose: () => resolve(action), dismiss: () => resolve() }));
    } },
    createWebviewPanel: { value(...args) {
      const panel = vscode.window.createWebviewPanel(...args);
      observer.panels.push(panel);
      return panel;
    } },
  });
  const host = Object.create(vscode, { lm: { value: lm }, window: { value: window } });
  const path = join(__dirname, "dist", "extension.js");
  const production = new Module(path, module);
  const load = production.require.bind(production);
  production.require = id => id === "vscode" ? host : load(id);
  production.load(path);
  production.exports.activate(context);
  return { secrets: context.secrets, provider, observer };
};
