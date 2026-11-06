import { test } from "node:test";
import assert from "node:assert/strict";
import { releasedUpdates } from "../shared/releases.ts";
test("Side by Side is a known update", () => {
  assert.ok(releasedUpdates("side_by_side").has("side_by_side"));
});
