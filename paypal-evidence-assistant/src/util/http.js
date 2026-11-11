/** HTTP helpers shared by routes and middleware. */

export class HttpError extends Error {
  constructor(status, message, expose = true) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.expose = expose; // whether the message is safe to show the client
  }
}

export function httpError(status, message, expose = true) {
  return new HttpError(status, message, expose);
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function applySecurityHeaders(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

export function sendHtml(res, status, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

export function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

export function redirect(res, location) {
  res.writeHead(303, { Location: location, 'Content-Length': 0 });
  res.end();
}

export function sendText(res, status, text) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

/**
 * Reads a request body with a hard byte cap. Rejects (413) and destroys the
 * socket if the declared or actual size exceeds the limit.
 */
export function readRawBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (err.status === 413) {
        // Respond cleanly instead of resetting the socket: mark the error so
        // the router closes the connection after sending the response, and
        // stop consuming the (potentially huge) body.
        err.closeConnection = true;
        req.pause();
        req.removeAllListeners('data');
      }
      reject(err);
    };
    const declared = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declared) && declared > limitBytes) {
      return fail(httpError(413, 'Request body too large'));
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) return fail(httpError(413, 'Request body too large'));
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => fail(err));
  });
}

export async function readJsonBody(req, limitBytes = 256 * 1024) {
  const raw = await readRawBody(req, limitBytes);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw httpError(400, 'JSON body must be an object');
    }
    return parsed;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw httpError(400, 'Malformed JSON body');
  }
}

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    try { out[name] = decodeURIComponent(part.slice(idx + 1).trim()); } catch { /* Ignore malformed cookie; never crash the server. */ }
  }
  return out;
}
