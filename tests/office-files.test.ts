import { test } from "node:test";
import assert from "node:assert/strict";
import { releasedUpdates } from "../shared/releases.ts";
test("Office Files is a known update", () => {
  assert.ok(releasedUpdates("office_files").has("office_files"));
});
