export const UPDATES = [
  { id: "mcp", name: "AI connections", dependencies: [] },
  { id: "rooms", name: "Encrypted Rooms", dependencies: [] },
  { id: "clerks", name: "AI Clerks", dependencies: [] },
  {
    id: "safe_drafts",
    name: "Safe transaction drafts",
    dependencies: ["clerks"],
  },
  { id: "minutes", name: "Signed Minutes", dependencies: [] },
  { id: "token_benefits", name: "Token-holder benefits", dependencies: [] },
  // Unlisted updates stay out of /api/config until they are released.
  { id: "playbooks", name: "Playbooks", dependencies: [], listed: false },
  { id: "side_by_side", name: "Side by Side", dependencies: [], listed: false },
  { id: "guest_passes", name: "Guest Passes", dependencies: [], listed: false },
  { id: "reimbursements", name: "Reimbursements", dependencies: [], listed: false },
  { id: "office_files", name: "Office Files", dependencies: [], listed: false },
] as const;
export function listedUpdate(update: (typeof UPDATES)[number]) {
  return !("listed" in update) || update.listed !== false;
}
export type UpdateId = (typeof UPDATES)[number]["id"];
export function releasedUpdates(value = ""): Set<UpdateId> {
  const requested = value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  for (const id of requested)
    if (!UPDATES.some((u) => u.id === id))
      throw new Error(`Unknown update: ${id}`);
  const set = new Set(requested as UpdateId[]);
  for (const u of UPDATES)
    if (set.has(u.id))
      for (const dependency of u.dependencies) {
        if (!set.has(dependency))
          throw new Error(`${u.id} requires ${dependency}`);
      }
  return set;
}
