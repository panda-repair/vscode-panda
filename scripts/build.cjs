const { build } = require("esbuild");
const { copyFileSync } = require("node:fs");

async function main() {
  await build({ entryPoints: ["src/extension.ts"], outfile: "dist/extension.js",
    bundle: true, platform: "node", target: "node22", format: "cjs",
    external: ["vscode"], minify: true, legalComments: "inline" });
  copyFileSync("node_modules/undici/LICENSE", "dist/undici-LICENSE.txt");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
