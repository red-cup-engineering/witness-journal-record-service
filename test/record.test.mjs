import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
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

test("settlement appends judgments without deleting any original ledger witnesses", () => {
  withTempRoot((root) => {
    const feed = "feed-b";
    const rows = [
      entry("s1", "urn:rmn:observed", "a", AT),
      entry("s2", "urn:rmn:observed", "b", AT),
      entry("s3", "urn:rmn:observed", "c", AT),
    ];
    appendEntries(root, feed, rows, AT);
    const originalPath = logPathFor(root, feed, AT);
    const originalBytes = readFileSync(originalPath, "utf8");
    const judgement = row => row.e === "s2" ? undefined : { verdict: "held" };

    const result = commitSettledRecord(root, feed, { at: AT, judge: judgement });
    assert.equal(result.appended, 2);
    assert.deepEqual(readDatomsAtPath(recordPathFor(root, feed, AT)).map(d => d[0]), ["s1", "s3"]);
    assert.deepEqual(readEntriesAtPath(originalPath), rows);
    assert.equal(readFileSync(originalPath, "utf8"), originalBytes,
      "knowledge never shrinks because an assessor made a judgment");

    const replay = commitSettledRecord(root, feed, { at: AT, judge: judgement });
    assert.equal(replay.appended, 0, "the same reading adds no second Datom");
    const opposed = commitSettledRecord(root, feed, {
      at: AT, judge: row => row.e === "s1" ? { verdict: "denied" } : undefined,
    });
    assert.equal(opposed.appended, 1, "opposed judgments are retained instead of replacing support");
    assert.deepEqual(readDatomsAtPath(recordPathFor(root, feed, AT))
      .filter(d => d[0] === "s1").map(d => d[4].verdict), ["held", "denied"]);
    assert.equal(readFileSync(originalPath, "utf8"), originalBytes);
  });
});

test("source-derived settlement refuses invented Datoms and is a no-op without judgments", () => {
  withTempRoot(root => {
    const feed = "feed-c", rows = [entry("s1", "p", "v", AT)];
    appendEntries(root, feed, rows, AT);
    const before = readFileSync(logPathFor(root, feed, AT), "utf8");
    assert.throws(() => commitSettledRecord(root, feed, {
      datoms: [["fabricated", "p", "v", AT, "held"]], kept: [], at: AT,
    }), /judgment function/);
    assert.equal(commitSettledRecord(root, feed, { at: AT, judge: () => undefined }), undefined);
    assert.equal(existsSync(recordPathFor(root, feed, AT)), false);
    assert.equal(readFileSync(logPathFor(root, feed, AT), "utf8"), before);
  });
});

test("readDatomsAtPath reads back a missing file as no settled records", () => {
  withTempRoot((root) => {
    assert.deepEqual(readDatomsAtPath(path.join(root, "nope.record.jsonl")), []);
  });
});

test("corrupt settled records refuse rather than disappear from the settlement ledger", () => {
  withTempRoot((root) => {
    const filePath = path.join(root, "source.record.jsonl");
    const first = '["s","p",1,"2026-07-31T00:00:00Z","held"]';
    writeFileSync(filePath, first + "\n" + '["wrong","shape"]' + "\n");
    assert.throws(() => readDatomsAtPath(filePath), error =>
      error instanceof TypeError && error.message.includes(filePath + ":2"));
    assert.equal(readFileSync(filePath, "utf8"), first + "\n" + '["wrong","shape"]' + "\n");
    writeFileSync(filePath, first + "\n" + '{"truncated":' + "\n");
    assert.throws(() => readDatomsAtPath(filePath), error =>
      error instanceof SyntaxError && error.message.includes(filePath + ":2"));
    const directory = path.join(root, "unreadable-record");
    mkdirSync(directory);
    assert.throws(() => readDatomsAtPath(directory), error => error?.code === "EISDIR");
    assert.deepEqual(readDatomsAtPath(path.join(root, "missing.jsonl")), []);
  });
});
