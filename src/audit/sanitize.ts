const AUDIT_DENYLIST = /(password|passwd|token|secret|authorization|apikey|api_key|otp|pin)/i;

export function sanitizeAuditBody(body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map(sanitizeAuditBody);
  }
  if (body !== null && typeof body === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      body as Record<string, unknown>,
    )) {
      if (AUDIT_DENYLIST.test(key)) {
        continue;
      }
      out[key] = sanitizeAuditBody(value);
    }
    return out;
  }
  return body;
}
