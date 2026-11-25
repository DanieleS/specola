// Errors the runner produces itself, as opposed to the handler's own
// responses (docs/page-backends.md, "Wire formats (exact)"): the
// X-Specola-Error header and a JSON body.

export class RunnerError extends Error {
  constructor(status, code, message, ref) {
    super(message);
    this.status = status;
    this.code = code;
    this.ref = ref;
  }
}

export function sendError(res, status, code, message, ref) {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ error: code, message, ...(ref ? { ref } : {}) });
  // Nothing of a handler's half-applied head leaks into the error.
  for (const h of res.getHeaderNames()) res.removeHeader(h);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Specola-Error': code,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendJSON(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
