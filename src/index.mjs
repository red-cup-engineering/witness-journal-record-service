// witness-journal-record-service — settled records.
//
// A Datom is one entry plus the fifth-slot reading a caller judged about
// that cell: `[e, a, v, t, reading]`. This is the ONLY sense of "reading"
// this package touches — the settled-judgement sense the notes call the
// record tier's fifth slot, not the wire-form-isomorphism sense that stayed
// behind in `relating`'s coherence kernel (see the extraction report for
// what stayed behind and why).
//
// Settling is a caller judgment, not something this module decides on its
// own: you supply a `judge` function that looks at one entry and either
// returns the reading you are settling it with, or returns `undefined` to
// say "still live." This module only records that judgment: it appends the
// resulting Datoms to the record file and atomically rewrites the journal's
// live log to hold only the entries that stayed unsettled.
//
// Ruling 4 dissolved the notes' separate log/state/record/content path law
// as a hallucinated pipeline framing; it did not abolish settled records as
// a concept. A settled record is still an append-only log — of Datoms
// instead of entries — so it is filed as a sibling of the live log under the
// counterpart in the record tier, `<root>/data/records/<feed>-records/<date>-commit-<feed>.jsonl`,
// addressed by the eavt-services-section tier law.

import { mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";

import { projectDataArtifactPath } from "@red-cup-engineering/eavt-services-section/data-artifact-address";
import { serializeDatoms } from "@red-cup-engineering/json-file-codec-service/jsonl/eavt";
import { asEntry } from "@red-cup-engineering/witness-journal-entry-service";
import { logPathFor, readJsonLinesAtPath, writeEntriesAtomicAtPath } from "@red-cup-engineering/witness-journal-log-service";

/**
 * @typedef {import("@red-cup-engineering/json-file-codec-service").JsonValue} JsonValue
 * @typedef {import("@red-cup-engineering/witness-journal-entry-service").WitnessJournalEntry} WitnessJournalEntry
 * @typedef {readonly [e: JsonValue, a: JsonValue, v: JsonValue, t: JsonValue, reading: JsonValue]} Datom
 */

/**
 * Build one Datom from an entry and the reading a caller judged about it.
 *
 * @param {unknown} row
 * @param {JsonValue} readingValue
 * @returns {Datom}
 */
export function settledDatom(row, readingValue) {
  const normalized = asEntry(row);
  return Object.freeze([normalized.e, normalized.a, normalized.v, normalized.t, readingValue]);
}

/**
 * Settle a batch of entries against a caller-supplied judgement function.
 * `judge(entry)` returns the reading to settle that entry with, or
 * `undefined` to leave it live. The caller owns entirely which entries are
 * settled and which remain live — this function only records the split.
 *
 * @param {readonly unknown[]} rows
 * @param {(entry: WitnessJournalEntry) => JsonValue | undefined} judge
 * @returns {{ readonly datoms: readonly Datom[], readonly kept: readonly WitnessJournalEntry[] }}
 */
export function settle(rows, judge) {
  /** @type {Datom[]} */
  const datoms = [];
  /** @type {WitnessJournalEntry[]} */
  const kept = [];
  for (const row of rows) {
    const normalized = asEntry(row);
    const readingValue = judge(normalized);
    if (readingValue === undefined) {
      kept.push(normalized);
    } else {
      datoms.push(settledDatom(normalized, readingValue));
    }
  }
  return Object.freeze({ datoms: Object.freeze(datoms), kept: Object.freeze(kept) });
}

/**
 * The dated settled-record path for one feed: the record-tier counterpart of that
 * feed's live journal file.
 *
 * @param {string} root
 * @param {string} feed
 * @param {JsonValue} at
 * @returns {string}
 */
export function recordPathFor(root, feed, at) {
  return projectDataArtifactPath(logPathFor(root, feed, at), "record", "jsonl");
}

/**
 * Read the original five-slot Datoms through the one upstream JSONL reader.
 * ENOENT is empty, but malformed/unreadable input or an invalid record
 * MUST refuse. Skipping evidence would fabricate a settled ledger projection.
 */
export function readDatomsAtPath(filePath) {
  return readJsonLinesAtPath(filePath).map((value, index) => {
    if (!Array.isArray(value) || value.length !== 5)
      throw new TypeError(`witness-journal: malformed five-slot Datom at ${filePath}:${index + 1}`);
    return /** @type {Datom} */ (value);
  });
}

/**
 * Commit a settlement: append `datoms` to the record file, then atomically
 * rewrite the live journal to hold only `kept`. Empty Datom commits are
 * no-ops — settling nothing changes nothing, not even directory creation.
 *
 * @param {string} root
 * @param {string} feed
 * @param {{ readonly datoms: readonly Datom[], readonly kept: readonly unknown[], readonly at: JsonValue }} settlement
 * @returns {{ readonly recordPath: string, readonly logPath: string } | undefined}
 */
export function commitSettledRecord(root, feed, settlement) {
  const { datoms, kept, at } = settlement;
  if (datoms.length === 0) return undefined;
  const recordPath = recordPathFor(root, feed, at);
  mkdirSync(path.dirname(recordPath), { recursive: true });
  appendFileSync(recordPath, serializeDatoms(/** @type {any} */ (datoms)), "utf8");
  const logPath = logPathFor(root, feed, at);
  writeEntriesAtomicAtPath(logPath, kept.map((row) => asEntry(row)));
  return { recordPath, logPath };
}
