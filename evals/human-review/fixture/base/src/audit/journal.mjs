import { createHash } from 'node:crypto';

/** Append-only process journal for adapters that need an ordered event feed. */
export class Journal {
  constructor({ clock = Date.now, capacity = 1000 } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('invalid capacity');
    this.clock = clock;
    this.capacity = capacity;
    this.sequence = 0;
    this.events = [];
    this.lastDigest = '';
  }

  append(type, subject, details = {}) {
    if (typeof type !== 'string' || !type) throw new Error('event type is required');
    if (typeof subject !== 'string' || !subject) throw new Error('subject is required');
    const event = {
      sequence: this.sequence + 1,
      time: this.clock(),
      type,
      subject,
      details: structuredClone(details),
      previousDigest: this.lastDigest,
    };
    const digest = createHash('sha256').update(JSON.stringify(event)).digest('hex');
    this.sequence = event.sequence;
    this.lastDigest = digest;
    this.events.push({ ...event, digest });
    if (this.events.length > this.capacity) this.events.shift();
    return structuredClone(this.events.at(-1));
  }

  read({ after = 0, limit = 100, subject } = {}) {
    if (!Number.isInteger(after) || after < 0) throw new Error('invalid cursor');
    if (!Number.isInteger(limit) || limit < 1) throw new Error('invalid limit');
    const oldest = this.events[0]?.sequence ?? this.sequence + 1;
    if (after < oldest - 1) throw new Error('cursor has expired');
    return this.events
      .filter(event => event.sequence > after)
      .filter(event => subject === undefined || event.subject === subject)
      .slice(0, limit)
      .map(event => structuredClone(event));
  }

  checkpoint() {
    return { sequence: this.sequence, digest: this.lastDigest };
  }
}

/** Verify a contiguous exported segment, including its incoming digest. */
export function verifySegment(events, previousDigest = '') {
  let expectedSequence;
  for (const record of events) {
    const { digest, ...event } = record;
    if (event.previousDigest !== previousDigest) return false;
    if (expectedSequence !== undefined && event.sequence !== expectedSequence) return false;
    const actual = createHash('sha256').update(JSON.stringify(event)).digest('hex');
    if (digest !== actual) return false;
    previousDigest = digest;
    expectedSequence = event.sequence + 1;
  }
  return true;
}

/** Export a bounded segment with the anchor needed by an offline verifier. */
export function exportSegment(journal, options = {}) {
  const events = journal.read(options);
  return {
    previousDigest: events[0]?.previousDigest ?? journal.checkpoint().digest,
    events,
    checkpoint: journal.checkpoint(),
  };
}

export function summarizeEvents(events) {
  const counts = {};
  let firstSequence;
  let lastSequence;
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
    firstSequence ??= event.sequence;
    lastSequence = event.sequence;
  }
  return { counts, firstSequence, lastSequence };
}

export function readSubjectHistory(journal, subject, { after = 0, limit = 100 } = {}) {
  if (typeof subject !== 'string' || !subject) throw new Error('subject is required');
  return journal.read({ after, limit, subject });
}

/** A consumer advances only after its adapter has persisted a whole batch. */
export class JournalCursor {
  constructor(journal, after = 0) {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('invalid cursor');
    this.journal = journal;
    this.after = after;
    this.inFlight = undefined;
  }

  poll(limit = 100) {
    if (this.inFlight) return structuredClone(this.inFlight.events);
    const events = this.journal.read({ after: this.after, limit });
    if (events.length) {
      this.inFlight = { events, through: events.at(-1).sequence };
    }
    return structuredClone(events);
  }

  acknowledge(through) {
    if (!this.inFlight || through !== this.inFlight.through) {
      throw new Error('acknowledgement does not match pending batch');
    }
    this.after = through;
    this.inFlight = undefined;
    return this.after;
  }

  abandon() {
    const hadPending = this.inFlight !== undefined;
    this.inFlight = undefined;
    return hadPending;
  }

  snapshot() {
    return {
      after: this.after,
      pendingThrough: this.inFlight?.through,
      pendingCount: this.inFlight?.events.length ?? 0,
    };
  }
}
