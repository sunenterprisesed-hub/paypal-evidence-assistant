import http from 'node:http';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { Router } from './router.js';
import { makeLimiters } from './middleware.js';
import { getSession } from './auth.js';
import { hashPassword } from './auth.js';
import { DisputeService } from './services/disputeService.js';
import { EvidenceStore } from './services/evidenceStore.js';
import { registerRoutes } from './routes.js';

/**
 * Entry point. Creates the app, wires services and starts listening.
 * createApp is exported for tests: it builds everything without listening.
 */
export function createApp(env = process.env, { logger = console, fetchImpl } = {}) {
  const config = loadConfig(env);
  const db = openDatabase(config.dataDir);
  const limiters = makeLimiters();

  // The admin password hash is derived at boot from the environment and kept
  // in memory only; no credentials table, nothing to dump.
  const passwordHash = hashPassword(config.adminPassword);

  const disputeService = new DisputeService(db, config, fetchImpl);
  const evidenceStore = new EvidenceStore(db, config);

  const router = new Router(logger);
  registerRoutes(router, { config, db, limiters, disputeService, evidenceStore, logger });

  const server = http.createServer((req, res) => {
    req.session = getSession(req, db, config);
    req.passwordHash = passwordHash;
    router.handle(req, res);
  });

  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  return { server, config, db, disputeService, evidenceStore };
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain || process.env.START_SERVER === '1') {
  const { server, config } = createApp();
  server.listen(config.port, () => {
    console.log(`Dispute Evidence Assistant listening on http://localhost:${config.port}`);
    console.log(`Mode: ${config.appEnv} | Data: ${config.paypal.enabled ? 'PayPal sandbox' : 'DEMO (synthetic)'} | AI: ${config.ai.enabled ? config.ai.model : 'rule-based fallback'} | Submissions: ${config.submissionsEnabled ? 'enabled' : 'disabled'}`);
    if (config.ephemeralSecret) console.log('Note: no SESSION_SECRET set; using an ephemeral development secret (sessions reset on restart).');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log(`\n${signal} received, shutting down`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 5000).unref();
    });
  }
}
