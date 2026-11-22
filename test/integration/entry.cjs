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
  const host = Object.create(vscode, { lm: { value: lm } });
  const path = join(__dirname, "dist", "extension.js");
  const production = new Module(path, module);
  const load = production.require.bind(production);
  production.require = id => id === "vscode" ? host : load(id);
  production.load(path);
  production.exports.activate(context);
  return { secrets: context.secrets, provider };
};
