import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, chat } from "./fixture.ts";
import { uid } from "../server/crypto.ts";
test(
  "PostgreSQL: real driver migrations, role isolation and competing budget reservations",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30000 },
  async (t) => {
    const r = await fixture("", process.env.TEST_DATABASE_URL);
    t.after(() => r.db.close());
    const user = await r.login(),
      o = await r.office(user.account, "0.15");
    r.setCost(null);
    const [role] = await r.db.query("SELECT current_user");
    assert.equal(role.current_user, "chancery_service");
    const [tenantRole] = await r.db.office(o.id, (q) =>
      q.query("SELECT current_user"),
    );
    assert.equal(tenantRole.current_user, "chancery_office");
    assert.equal((await r.db.query("SELECT * FROM seats")).length, 0);
    assert.equal(
      (await r.db.office(o.id, (q) => q.query("SELECT * FROM seats"))).length,
      1,
    );
    const quotes = await Promise.all(
        Array.from({ length: 8 }, () => r.ledger.quote(o.access, chat)),
      ),
      results = await Promise.allSettled(
        quotes.map((q) =>
          r.ledger.request(o.access, { id: uid("req_"), quoteId: q.id, chat }),
        ),
      );
    assert.equal(results.filter((v) => v.status === "fulfilled").length, 1);
    assert.equal(r.calls(), 1);
    assert(
      results
        .filter((v) => v.status === "rejected")
        .every((v) => (v as PromiseRejectedResult).reason.code === "actor_cap"),
    );
  },
);
