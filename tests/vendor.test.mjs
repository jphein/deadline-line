import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// The vendored rules engine must be upstream's files byte for byte, apart from the two header lines
// scripts/vendor-decoder.sh adds (after a #! line, if the file has one). UPSTREAM.sha256 holds upstream's own hashes.
const dir = new URL("../vendor/deadline-decoder-mcp/", import.meta.url);
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

test("the vendored engine matches its recorded upstream files byte for byte", () => {
  const manifest = readFileSync(new URL("UPSTREAM.sha256", dir), "utf8");
  // The headers must cite the same upstream commit the hashes were recorded from (and a branch, not "HEAD").
  const recorded = manifest.match(/^# jphein\/deadline-decoder-mcp (\S+) @ ([0-9a-f]{40})$/m);
  assert.ok(recorded, "UPSTREAM.sha256 names the upstream branch and commit");
  assert.notEqual(recorded[1], "HEAD", "vendored from a branch, not a detached checkout");
  const lines = manifest.split("\n").filter(l => l && !l.startsWith("#"));
  assert.equal(lines.length, 6);
  for (const line of lines) {
    const [want, file] = line.split(/\s+/);
    let text = readFileSync(new URL(file, dir), "utf8");
    if (file !== "LICENSE") {
      const rows = text.split("\n");
      const at = rows[0].startsWith("#!") ? 1 : 0;
      const cited = rows[at].match(/^\/\/ Vendored from jphein\/deadline-decoder-mcp \((\S+) @ ([0-9a-f]+)\)/);
      assert.ok(cited, `${file}: header`);
      assert.equal(cited[1], recorded[1], `${file}: header cites the recorded branch`);
      assert.ok(recorded[2].startsWith(cited[2]), `${file}: header cites ${cited[2]}, the hashes are from ${recorded[2]}`);
      assert.match(rows[at + 1], /^\/\/ Upstream edits belong upstream/, `${file}: header`);
      rows.splice(at, 2);
      text = rows.join("\n");
    }
    assert.equal(sha(text), want, `${file} differs from upstream`);
  }
});
