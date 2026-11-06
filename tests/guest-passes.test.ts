import { test } from "node:test";
import assert from "node:assert/strict";
import { releasedUpdates } from "../shared/releases.ts";
test("Guest Passes is a known update", () => {
  assert.ok(releasedUpdates("guest_passes").has("guest_passes"));
});
