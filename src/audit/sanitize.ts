const AUDIT_DENYLIST = new Set([
  'password',
  'password_hash',
  'passwordhash',
  'token',
  'refreshtoken',
  'authorization',
]);

export function sanitizeAuditBody(body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map(sanitizeAuditBody);
  }
  if (body !== null && typeof body === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      body as Record<string, unknown>,
    )) {
      if (AUDIT_DENYLIST.has(key.toLowerCase())) {
        continue;
      }
      out[key] = sanitizeAuditBody(value);
    }
    return out;
  }
  return body;
}
