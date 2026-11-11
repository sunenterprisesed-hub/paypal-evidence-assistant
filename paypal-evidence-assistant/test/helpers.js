import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

/**
 * Test helpers: boot the real app against a temp data dir on an ephemeral
 * port, plus a minimal cookie-aware HTTP client. No mocking of the app
 * itself - integration tests exercise the real server stack.
 */

export function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pea-test-'));
}

export function bootApp(envOverrides = {}, options = {}) {
  const dataDir = makeTempDir();
  const env = {
    APP_ENV: 'development',
    PORT: '0',
    DATA_DIR: dataDir,
    ADMIN_USERNAME: 'demo',
    ADMIN_PASSWORD: 'demo-password',
    SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ...envOverrides,
  };
  const logger = { log() {}, warn() {}, error: options.captureErrors ? options.captureErrors : () => {} };
  const app = createApp(env, { logger, fetchImpl: options.fetchImpl });
  return new Promise((resolve) => {
    app.server.listen(0, '127.0.0.1', () => {
      resolve({ ...app, baseUrl: `http://127.0.0.1:${app.server.address().port}`, dataDir });
    });
  });
}

export function closeApp(app) {
  return new Promise((resolve) => {
    app.db.close();
    app.server.close(resolve);
  });
}

/** Minimal cookie-jar client. */
export class Client {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
  }

  #cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  #storeCookies(res) {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of set) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(method, path, { headers = {}, body, redirect = 'manual' } = {}) {
    const res = await fetch(this.baseUrl + path, {
      method,
      redirect,
      headers: { Cookie: this.#cookieHeader(), ...headers },
      body,
    });
    this.#storeCookies(res);
    return res;
  }

  get(path, opts) { return this.request('GET', path, opts); }
  post(path, opts) { return this.request('POST', path, opts); }

  async login(username = 'demo', password = 'demo-password') {
    const res = await this.post('/login', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
    });
    return res;
  }

  /** Logs in and returns { res, csrf } scraped from the dashboard meta tag. */
  async loginAndGetCsrf() {
    await this.login();
    const res = await this.get('/');
    const html = await res.text();
    const match = html.match(/name="csrf-token" content="([^"]+)"/);
    return { csrf: match ? match[1] : null, html };
  }
}
