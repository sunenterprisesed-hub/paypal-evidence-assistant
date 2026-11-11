import { sendJson, applySecurityHeaders, HttpError } from './util/http.js';

/**
 * Minimal router with :param path segments and a central error boundary.
 * The error boundary never leaks internals to the client.
 */
export class Router {
  constructor(logger = console) {
    this.routes = [];
    this.logger = logger;
  }

  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(
      '^' + pattern.split('/').map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('/') + '/?$'
    );
    this.routes.push({ method, regex, keys, handler });
  }

  get(pattern, handler) { this.add('GET', pattern, handler); }
  post(pattern, handler) { this.add('POST', pattern, handler); }

  async handle(req, res) {
    applySecurityHeaders(res);
    let pathname = '(invalid URL)';
    try {
      const url = new URL(req.url, 'http://localhost');
      pathname = url.pathname;
      for (const route of this.routes) {
        if (route.method !== req.method) continue;
        const match = route.regex.exec(pathname);
        if (!match) continue;
        const params = {};
        route.keys.forEach((key, i) => { params[key] = decodeURIComponent(match[i + 1]); });
        req.params = params;
        req.query = url.searchParams;
        await route.handler(req, res);
        if (!res.writableEnded) {
          this.logger.error(`Handler for ${req.method} ${pathname} did not end the response`);
          sendJson(res, 500, { error: 'Internal error' });
        }
        return;
      }
      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      if (res.writableEnded) {
        this.logger.error('Error after response ended:', err);
        return;
      }
      const status = err instanceof URIError ? 400 : err instanceof HttpError ? err.status : 500;
      if (err.closeConnection) {
        // Body exceeded the cap: send the error, then close the connection
        // without reading the rest of the body.
        res.on('finish', () => req.socket.destroy());
      }
      if (err instanceof HttpError && err.expose) {
        sendJson(res, status, { error: err.message });
      } else {
        // Log full detail server-side; the client gets a generic message.
        this.logger.error(`Unhandled error on ${req.method} ${pathname}:`, err);
        sendJson(res, status, { error: 'Internal error' });
      }
    }
  }
}
