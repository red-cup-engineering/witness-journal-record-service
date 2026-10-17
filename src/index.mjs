// witness-journal-record-service — settled records.
//
// A Datom is one entry plus the fifth-slot reading a caller judged about
// that cell: `[e, a, v, t, reading]`. This is the ONLY sense of "reading"
// this package touches — the settled-judgement sense the notes call the
// record tier's fifth slot, not the wire-form-isomorphism sense that stayed
// behind in `relating`'s coherence kernel (see the extraction report for
// what stayed behind and why).
//
// Settling is a caller judgment, not a theorem or an erasure operation.
// Read actual original evidence from the append-only log. Retain all inputs
// and append every distinct judgment as a separate Datom; never compact
// away contrary or superseded witnesses.
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
import { canonical } from "@red-cup-engineering/json-file-codec-service";
import { logPathFor, readEntriesAtPath, readJsonLinesAtPath } from "@red-cup-engineering/witness-journal-log-service";

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
 * Receive a settlement over the actual original log, never over caller-
 * supplied Datoms. The judgment comes from an explicit authorized caller;
 * this code neither infers truth nor invents a witness.
 *
 * A settlement is an ADDITIONAL, append-only reading. Every original
 * witnessed EAVT row survives for alternative or opposing later judgments.
 * Replaying an unchanged judgment records no duplicate; a different reading
 * remains independently visible instead of overwriting the earlier one.
 *
 * Requires a single-writer journal root. Cross-process transaction admission
 * belongs to the owner of the filesystem journal, not a hidden retry here.
 */
export function commitSettledRecord(root, feed, { at, judge } = {}) {
  if (typeof judge !== "function")
    throw new TypeError("settlement requires a source-reading judgment function");
  const logPath = logPathFor(root, feed, at);
  const originals = readEntriesAtPath(logPath);
  const { datoms } = settle(originals, judge);
  if (datoms.length === 0) return undefined;
  const recordPath = recordPathFor(root, feed, at);
  const known = new Set(readDatomsAtPath(recordPath).map(canonical));
  const fresh = [];
  for (const datom of datoms) {
    const id = canonical(datom);
    if (known.has(id)) continue;
    known.add(id);
    fresh.push(datom);
  }
  if (fresh.length > 0) {
    mkdirSync(path.dirname(recordPath), { recursive: true });
    appendFileSync(recordPath, serializeDatoms(fresh), "utf8");
  }
  return Object.freeze({ recordPath, logPath, appended: fresh.length });
}
