import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { entry } from "@red-cup-engineering/witness-journal-entry-service";
import { appendEntries, readEntriesAtPath, logPathFor } from "@red-cup-engineering/witness-journal-log-service";
import { settledDatom, settle, recordPathFor, readDatomsAtPath, commitSettledRecord } from "../src/index.mjs";

function withTempRoot(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "witness-journal-record-test-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const AT = "2026-07-31T12:00:00.000Z";

test("settledDatom builds the five-part [e, a, v, t, reading] shape", () => {
  const row = entry("s", "urn:rmn:observed", "v", AT);
  const datom = settledDatom(row, { kind: "witness-journal.record.reading", verdict: "held" });
  assert.equal(datom.length, 5);
  assert.deepEqual(datom, ["s", "urn:rmn:observed", "v", AT, { kind: "witness-journal.record.reading", verdict: "held" }]);
});

test("settle splits entries into settled Datoms and still-live kept entries by caller judgment", () => {
  const rows = [
    entry("s1", "urn:rmn:observed", "a", AT),
    entry("s2", "urn:rmn:observed", "b", AT),
    entry("s3", "urn:rmn:observed", "c", AT),
  ];
  const { datoms, kept } = settle(rows, (row) => (row.e === "s2" ? undefined : { verdict: "settled" }));
  assert.equal(datoms.length, 2);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].e, "s2");
  assert.deepEqual(
    datoms.map((d) => d[0]),
    ["s1", "s3"],
  );
});

test("settle with a judge that settles nothing keeps every entry live", () => {
  const rows = [entry("s1", "p", "v", AT)];
  const { datoms, kept } = settle(rows, () => undefined);
  assert.equal(datoms.length, 0);
  assert.equal(kept.length, 1);
});

test("recordPathFor is the record-tier counterpart of the live journal file", () => {
  withTempRoot((root) => {
    const logPath = logPathFor(root, "feed-a", AT);
    const recordPath = recordPathFor(root, "feed-a", AT);
    assert.equal(recordPath, path.join(root, "data", "records", "feed-a-records", "2026-07-31-commit-feed-a.jsonl"));
  });
});

test("commitSettledRecord appends Datoms to the record file and compacts the live log to kept", () => {
  withTempRoot((root) => {
    const feed = "feed-b";
    const rows = [
      entry("s1", "urn:rmn:observed", "a", AT),
      entry("s2", "urn:rmn:observed", "b", AT),
      entry("s3", "urn:rmn:observed", "c", AT),
    ];
    appendEntries(root, feed, rows, AT);

    const { datoms, kept } = settle(rows, (row) => (row.e === "s2" ? undefined : { verdict: "settled" }));
    const result = commitSettledRecord(root, feed, { datoms, kept, at: AT });
    assert.ok(result);

    const settledBack = readDatomsAtPath(recordPathFor(root, feed, AT));
    assert.equal(settledBack.length, 2);
    assert.deepEqual(
      settledBack.map((d) => d[0]).sort(),
      ["s1", "s3"],
    );
    for (const datom of settledBack) assert.equal(datom.length, 5);

    // The live log is atomically rewritten to only the kept (still-live) entry.
    const liveLog = readEntriesAtPath(logPathFor(root, feed, AT));
    assert.equal(liveLog.length, 1);
    assert.equal(liveLog[0].e, "s2");
  });
});

test("commitSettledRecord is a no-op when there is nothing to settle", () => {
  withTempRoot((root) => {
    const feed = "feed-c";
    const rows = [entry("s1", "p", "v", AT)];
    appendEntries(root, feed, rows, AT);

    const { datoms, kept } = settle(rows, () => undefined);
    const result = commitSettledRecord(root, feed, { datoms, kept, at: AT });
    assert.equal(result, undefined);

    assert.equal(existsSync(recordPathFor(root, feed, AT)), false, "no record file materializes for an empty commit");
    const liveLog = readEntriesAtPath(logPathFor(root, feed, AT));
    assert.equal(liveLog.length, 1, "the live log is untouched");
  });
});

test("readDatomsAtPath reads back a missing file as no settled records", () => {
  withTempRoot((root) => {
    assert.deepEqual(readDatomsAtPath(path.join(root, "nope.record.jsonl")), []);
  });
});
