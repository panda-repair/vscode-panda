const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

test("packaging a fresh private checkout produces the same VSIX and preserves its permissions", { skip: process.platform === "win32" }, t => {
  const root = resolve(__dirname, "..");
  const { name, version } = require("../package.json");
  const filename = `${name}-${version}.vsix`;
  const temp = mkdtempSync(join(tmpdir(), "panda-package-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  function pack(mask, args, output = filename) {
    const cwd = join(temp, mask);
    mkdirSync(cwd);
    for (const name of ["src", "scripts", "tsconfig.json", "package.json", "LICENSE", "README.md"]) {
      cpSync(join(root, name), join(cwd, name), { recursive: true });
    }
    const mode = 0o666 & ~parseInt(mask, 8);
    const readme = join(cwd, "README.md");
    chmodSync(readme, mode);
    chmodSync(join(cwd, "LICENSE"), mode);
    symlinkSync(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
    assert.equal(existsSync(join(cwd, "dist")), false);
    const preload = join(cwd, "mask.cjs");
    writeFileSync(preload, `process.umask(0o${mask});\n`);
    execFileSync(process.execPath, ["--require", preload, "scripts/package.cjs", ...args], {
      cwd, env: { ...process.env, TZ: "UTC", SOURCE_DATE_EPOCH: "1700000000" }, stdio: "pipe",
    });
    assert.equal(statSync(readme).mode & 0o777, mode);
    return readFileSync(join(cwd, output));
  }
  const standard = pack("022", []);
  assert.deepEqual(pack("077", ["--out", "./selected.vsix"], "selected.vsix"), standard);
});
