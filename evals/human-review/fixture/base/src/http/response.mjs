export function json(status, body, headers = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: structuredClone(body),
  };
}

export function errorResponse(error) {
  const message = error.message || 'request failed';
  if (message === 'order not found') return json(404, { error: message });
  if (message === 'version conflict') return json(409, { error: message });
  const clientErrors = [
    'customer is required', 'items are required', 'sku is required',
    'price must be nonnegative integer cents', 'quantity must be a positive integer',
    'line total exceeds supported range', 'limit must be between 1 and 100',
  ];
  if (clientErrors.includes(message) || message.startsWith('cannot move ')) {
    return json(400, { error: message });
  }
  return json(500, { error: 'request failed' });
}

export function pagination(query = {}) {
  const limit = Number(query.limit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be between 1 and 100');
  }
  return { after: String(query.after ?? ''), limit };
}
