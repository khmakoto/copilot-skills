import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { journals } from "../lib/state.mjs";

function journalFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-graph-state-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const operations = path.join(dir, "operations");
  fs.mkdirSync(operations);
  return { ctx: { dir }, operations };
}

test("journal projections run before reading the next journal", (t) => {
  const { ctx, operations } = journalFixture(t);
  for (const id of ["a", "b"]) {
    fs.writeFileSync(path.join(operations, `${id}.json`), JSON.stringify({ id, status: "done" }));
  }
  const projected = journals(ctx, ({ id, status }) => {
    if (id === "a") {
      fs.writeFileSync(path.join(operations, "b.json"), JSON.stringify({ id: "b", status: "running" }));
    }
    return { id, status };
  });
  assert.deepEqual(projected, [{ id: "a", status: "done" }, { id: "b", status: "running" }]);
});

test("projected scans still reject malformed journals and support missing directories", (t) => {
  const { ctx, operations } = journalFixture(t);
  fs.writeFileSync(path.join(operations, "a.json"), JSON.stringify({ id: "a", status: "done" }));
  fs.writeFileSync(path.join(operations, "b.json"), "invalid json");
  assert.throws(() => journals(ctx, ({ id, status }) => ({ id, status })), /Cannot read .*b\.json/);
  assert.deepEqual(journals({ dir: path.join(ctx.dir, "missing") }, (journal) => journal.id), []);
});

test("unprojected scans preserve full historical journal evidence", (t) => {
  const { ctx, operations } = journalFixture(t);
  const journal = {
    id: "a", status: "done", historyVersion: 1,
    plan: { graph: { id: "example" }, previous: { revision: 1 } },
    candidate: { revision: 2 },
    published: { model: { head: "published-head", scope: "remote-refs" } },
    recoveries: [{ action: "reconcile", operation: "recovery" }],
  };
  fs.writeFileSync(path.join(operations, "a.json"), JSON.stringify(journal));
  assert.deepEqual(journals(ctx, ({ id, status }) => ({ id, status })),
    [{ id: "a", status: "done" }]);
  assert.deepEqual(journals(ctx), [journal]);
});
