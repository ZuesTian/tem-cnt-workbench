import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {WorkspaceRenderer} from "../static/js/ui/workspace-renderer.js";

test("a loaded image preserves public-mode model restrictions", () => {
  const fields = new Map();
  globalThis.document = {body:{classList:{contains: () => true}}, querySelector(name) {
    if (!fields.has(name)) fields.set(name, {value:1, classList:{toggle() {}}});
    return fields.get(name);
  }};
  try {
    new WorkspaceRenderer({}).renderControls({image:true, active:false, unavailable:false, scaleSet:true, hasResults:true});
    assert.equal(fields.get("#model-path").disabled, true);
    assert.equal(fields.get("#enable-tta").disabled, true);
    assert.equal(fields.get("#iou-threshold").disabled, false);
  } finally { delete globalThis.document; }
});

test("all workspace controls have unique IDs", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(ids.length, new Set(ids).size);
});
