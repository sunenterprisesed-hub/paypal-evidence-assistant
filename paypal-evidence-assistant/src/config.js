import crypto from 'node:crypto';
import path from 'node:path';

export class ConfigError extends Error {
  constructor(errors) {
    super('Invalid configuration:\n- ' + errors.join('\n- '));
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function asInt(value, fallback, { min, max } = {}) {
  const n = Number.parseInt(value ?? '', 10);
  if (Number.isNaN(n)) return fallback;
  if (min !== undefined && n < min) return fallback;
  if (max !== undefined && n > max) return fallback;
  return n;
}

/**
 * Loads and validates configuration from environment variables.
 * Fails closed: in production, missing secrets stop the boot.
 * In development, safe ephemeral defaults are used and clearly logged.
 */
export function loadConfig(env = process.env) {
  const errors = [];
  const appEnv = env.APP_ENV === 'production' ? 'production' : 'development';
  const isProd = appEnv === 'production';

  // --- Session secret ---
  let sessionSecret = env.SESSION_SECRET || '';
  let ephemeralSecret = false;
  if (!sessionSecret) {
    if (isProd) {
      errors.push('SESSION_SECRET is required in production (32+ random characters)');
    } else {
      sessionSecret = crypto.randomBytes(32).toString('hex');
      ephemeralSecret = true; // sessions do not survive restarts in dev; acceptable
    }
  } else if (sessionSecret.length < 32) {
    errors.push('SESSION_SECRET must be at least 32 characters');
  }

  // --- Admin credentials ---
  const adminUsername = env.ADMIN_USERNAME || (isProd ? '' : 'demo');
  const adminPassword = env.ADMIN_PASSWORD || (isProd ? '' : 'demo-password');
  if (!adminUsername || !adminPassword) {
    errors.push('ADMIN_USERNAME and ADMIN_PASSWORD are required in production');
  }
  if (isProd && adminPassword === 'demo-password') {
    errors.push('ADMIN_PASSWORD must not be the development default in production');
  }
  if (adminPassword && adminPassword.length < 12) {
    errors.push('ADMIN_PASSWORD must be at least 12 characters');
  }

  // --- PayPal ---
  const paypalEnv = env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox';
  const paypalClientId = (env.PAYPAL_CLIENT_ID || '').trim();
  const paypalClientSecret = (env.PAYPAL_CLIENT_SECRET || '').trim();
  if (paypalClientId && !paypalClientSecret) errors.push('PAYPAL_CLIENT_SECRET is set without PAYPAL_CLIENT_ID or vice versa');
  if (paypalClientSecret && !paypalClientId) errors.push('PAYPAL_CLIENT_ID is set without PAYPAL_CLIENT_SECRET or vice versa');
  if (paypalEnv === 'live') {
    errors.push('PAYPAL_ENV=live is not supported by this build; use sandbox');
  }

  // --- AI provider ---
  const aiProvider = (env.AI_PROVIDER || '').trim();
  const aiBaseUrl = (env.AI_BASE_URL || '').trim();
  const aiApiKey = (env.AI_API_KEY || '').trim();
  const aiModel = (env.AI_MODEL || '').trim();
  if (aiProvider && aiProvider !== 'openai-compatible') {
    errors.push(`AI_PROVIDER "${aiProvider}" is not supported; use "openai-compatible"`);
  }
  if (aiProvider) {
    if (!aiBaseUrl || !aiApiKey || !aiModel) {
      errors.push('AI_PROVIDER requires AI_BASE_URL, AI_API_KEY and AI_MODEL');
    }
    try {
      const url = new URL(aiBaseUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) errors.push('AI_BASE_URL must be a plain HTTPS provider origin/path without credentials, query or fragment');
    } catch { errors.push('AI_BASE_URL must be a valid HTTPS URL'); }
  }

  if (errors.length > 0) throw new ConfigError(errors);

  const dataDir = path.resolve(env.DATA_DIR || './data');

  return Object.freeze({
    appEnv,
    isProd,
    port: asInt(env.PORT, 3000, { min: 1, max: 65535 }),
    sessionSecret,
    ephemeralSecret,
    adminUsername,
    adminPassword,
    dataDir,
    maxUploadBytes: asInt(env.MAX_UPLOAD_BYTES, 5 * 1024 * 1024, { min: 1024, max: 25 * 1024 * 1024 }),
    maxFilesPerDispute: 20,
    sessionTtlMs: 12 * 60 * 60 * 1000, // 12 hours
    submissionsEnabled: asBool(env.SUBMISSIONS_ENABLED, false),
    paypal: Object.freeze({
      enabled: Boolean(paypalClientId && paypalClientSecret),
      env: paypalEnv,
      baseUrl: 'https://api-m.sandbox.paypal.com', // fixed; never user-controlled
      clientId: paypalClientId,
      clientSecret: paypalClientSecret,
    }),
    ai: Object.freeze({
      enabled: Boolean(aiProvider),
      provider: aiProvider || null,
      baseUrl: aiBaseUrl || null,
      apiKey: aiApiKey || null,
      model: aiModel || null,
      timeoutMs: 20000,
    }),
  });
}
