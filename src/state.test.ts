import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deleteRecord, openState, readRecord, writeRecord } from "./state.js";

test("persists OAuth records across database reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "t3-bridge-state-"));
  try {
    process.umask(0o077);
    const db = openState(dir);
    writeRecord(db, "lab", "tokens", { access_token: "example" });
    db.close();
    assert.equal(statSync(join(dir, "gateway.sqlite")).mode & 0o777, 0o600);
    const reopened = openState(dir);
    assert.deepEqual(readRecord(reopened, "lab", "tokens"), { access_token: "example" });
    deleteRecord(reopened, "lab", "tokens");
    assert.equal(readRecord(reopened, "lab", "tokens"), undefined);
    reopened.close();
  } finally { rmSync(dir, { recursive: true }); }
});
