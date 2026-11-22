const { build } = require("esbuild");
const { readFileSync, writeFileSync } = require("node:fs");

async function main() {
  await build({ entryPoints: ["src/extension.ts"], outfile: "dist/extension.js",
    bundle: true, platform: "node", target: "node22", format: "cjs",
    external: ["vscode"], minify: true, legalComments: "inline" });
  writeFileSync("dist/undici-LICENSE.txt", readFileSync("node_modules/undici/LICENSE"));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
