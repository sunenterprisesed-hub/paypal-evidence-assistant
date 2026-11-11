import crypto from 'node:crypto';

/** 128-bit random hex id for sessions, files, reports, etc. */
export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
