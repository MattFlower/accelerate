import { validatePolicy } from '../retry/policy.mjs';

function integer(env, name, fallback) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${name}`);
  return value;
}

export function loadSettings(env = process.env) {
  return Object.freeze({
    port: integer(env, 'PORT', 8080),
    cacheCapacity: integer(env, 'CACHE_CAPACITY', 128),
    retry: validatePolicy({
      baseMs: integer(env, 'RETRY_BASE_MS', 100),
      capMs: integer(env, 'RETRY_CAP_MS', 10000),
      maxAttempts: integer(env, 'RETRY_ATTEMPTS', 4),
    }),
    exportLimit: integer(env, 'EXPORT_LIMIT', 500),
  });
}

function boolean(env, name, fallback) {
  const value = env[name];
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`invalid ${name}`);
}

function list(env, name, fallback = []) {
  if (env[name] === undefined) return [...fallback];
  const values = env[name].split(',').map(value => value.trim());
  if (values.some(value => !value)) throw new Error(`invalid ${name}`);
  return [...new Set(values)];
}

/** Adapter options are parsed separately so the core needs no secrets to start. */
export function loadAdapterSettings(env = process.env) {
  const origins = list(env, 'ALLOWED_ORIGINS');
  for (const origin of origins) {
    const url = new URL(origin);
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin) {
      throw new Error('invalid origin');
    }
  }
  const auditCapacity = integer(env, 'AUDIT_CAPACITY', 1000);
  const requestTimeoutMs = integer(env, 'REQUEST_TIMEOUT_MS', 30000);
  const reportPageSize = integer(env, 'REPORT_PAGE_SIZE', 50);
  if (reportPageSize > 100) throw new Error('report page size exceeds 100');
  return Object.freeze({
    auditCapacity,
    requestTimeoutMs,
    reportPageSize,
    allowAnonymousReports: boolean(env, 'ALLOW_ANONYMOUS_REPORTS', false),
    origins: Object.freeze(origins),
  });
}

export function settingsForLog(settings) {
  return {
    port: settings.port,
    cacheCapacity: settings.cacheCapacity,
    exportLimit: settings.exportLimit,
    retry: { ...settings.retry },
  };
}

export function mergeEnvironment(defaults, overrides) {
  const result = { ...defaults };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new Error(`environment value must be text: ${name}`);
    result[name] = value;
  }
  return result;
}
