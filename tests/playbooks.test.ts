import { test } from "node:test";
import assert from "node:assert/strict";
import { releasedUpdates } from "../shared/releases.ts";
test("Playbooks is a known update", () => {
  assert.ok(releasedUpdates("playbooks").has("playbooks"));
});
