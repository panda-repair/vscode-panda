const { execFileSync } = require("node:child_process");
const { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { listFiles, PackageManager } = require("@vscode/vsce");

async function main() {
  const root = process.cwd();
  const args = process.argv.slice(2);
  // vsce runs in a private staging directory. Output paths still refer to the caller's checkout.
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--out" || args[i] === "-o") && args[i + 1]) {
      i++;
      args[i] = resolve(root, args[i]);
    } else if (args[i].startsWith("--out=")) {
      args[i] = "--out=" + resolve(root, args[i].slice(6));
    } else if (/^-o./.test(args[i])) {
      args[i] = "-o" + resolve(root, args[i].slice(2));
    }
  }
  const files = await listFiles({ cwd: root, packageManager: PackageManager.None });
  const stage = mkdtempSync(join(tmpdir(), "panda-vsix-"));
  try {
    if (process.platform !== "win32") process.umask(0o022);
    for (const name of files) {
      if (name.startsWith("dist/")) continue; // The regular vscode:prepublish hook rebuilds dist.
      const destination = join(stage, name);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(root, name), destination);
      chmodSync(destination, 0o644);
    }
    for (const name of ["src", "scripts", "tsconfig.json"]) {
      cpSync(join(root, name), join(stage, name), { recursive: true });
    }
    symlinkSync(join(root, "node_modules"), join(stage, "node_modules"), "junction");
    const cli = require.resolve("@vscode/vsce/vsce");
    execFileSync(process.execPath, [cli, "package", "--no-dependencies", "--allow-missing-repository", "--out", root, ...args],
      { cwd: stage, stdio: "inherit" });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
