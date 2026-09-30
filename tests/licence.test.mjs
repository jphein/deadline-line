import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const vendored = (dir = "vendor/deadline-decoder-mcp/src") =>
  readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? vendored(`${dir}/${e.name}`) : e.name.endsWith(".js") ? [`${dir}/${e.name}`] : []);

test("the licence metadata names every licence the vendored files carry", () => {
  const pkg = JSON.parse(read("package.json")).license, lock = JSON.parse(read("package-lock.json")).packages[""].license;
  assert.equal(lock, pkg);
  assert.ok(pkg.split(" AND ").includes("MIT"), `package.json licence "${pkg}" keeps MIT for this repository's own files`);
  const files = vendored();
  assert.ok(files.length >= 5);
  for (const f of files) {
    const spdx = read(f).match(/^\/\/ Vendored from .*?, licensed (\S+?):/m)?.[1];
    assert.ok(spdx, `${f} has a vendoring header`);
    assert.ok(pkg.split(" AND ").includes(spdx), `package.json licence "${pkg}" includes ${spdx} (${f})`);
    if (spdx !== "MIT") assert.match(read("LICENSE"), /except those under\s+vendor\/deadline-decoder-mcp\//, "the root LICENSE scopes itself");
  }
});
