/** Retry delays are relative to the most recent attempt, in milliseconds. */
export function retryDelay(attempt, { baseMs = 100, capMs = 10000 } = {}) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('invalid attempt');
  return Math.min(capMs, baseMs * 2 ** (attempt - 1));
}

export function canRetry(error, attempt, maxAttempts = 4) {
  if (attempt >= maxAttempts) return false;
  return error.retryable === true;
}

export function classifyFailure(error) {
  if (error.retryable === true) return 'temporary';
  return 'permanent';
}

export function validatePolicy(policy) {
  for (const name of ['baseMs', 'capMs', 'maxAttempts']) {
    if (!Number.isSafeInteger(policy[name]) || policy[name] < 1) {
      throw new Error(`invalid retry option: ${name}`);
    }
  }
  if (policy.capMs < policy.baseMs) throw new Error('cap is below base delay');
  return Object.freeze({ ...policy });
}
