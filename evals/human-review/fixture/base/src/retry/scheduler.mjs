import { retryDelay, canRetry } from './policy.mjs';

/** A single-process due-work queue. Delivery adapters own network I/O. */
export class Scheduler {
  constructor(policy, clock = Date.now) {
    this.policy = policy;
    this.clock = clock;
    this.pending = [];
    this.finished = [];
  }

  enqueue(id, payload) {
    if (this.pending.some(job => job.id === id)) return false;
    this.pending.push({ id, payload: structuredClone(payload), attempt: 1, due: this.clock() });
    return true;
  }

  async tick(deliver) {
    const now = this.clock();
    const ready = this.pending.filter(job => job.due <= now);
    this.pending = this.pending.filter(job => job.due > now);
    for (const job of ready) {
      try {
        await deliver(structuredClone(job.payload));
        this.finished.push({ id: job.id, outcome: 'sent' });
      } catch (error) {
        if (canRetry(error, job.attempt, this.policy.maxAttempts)) {
          const due = now + retryDelay(job.attempt, this.policy);
          this.pending.push({ ...job, attempt: job.attempt + 1, due });
        } else {
          this.finished.push({ id: job.id, outcome: 'failed' });
        }
      }
    }
    return ready.length;
  }

  snapshot() {
    return structuredClone({ pending: this.pending, finished: this.finished });
  }
}
