import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Storage layer. Uses Node's built-in SQLite with prepared statements only.
 * All queries are parameterized; no string interpolation of user input into SQL.
 */
export function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true, mode: 0o700 });

  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      csrf_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS disputes (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,                -- 'demo' | 'paypal-sandbox'
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      amount TEXT NOT NULL,
      currency TEXT NOT NULL,
      buyer_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      response_due_at TEXT,
      raw_json TEXT,                       -- last raw payload when fetched from PayPal
      manual_status TEXT,                  -- user-reported status for manual tracks
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS case_context (
      dispute_id TEXT PRIMARY KEY REFERENCES disputes(id) ON DELETE CASCADE,
      business_type TEXT NOT NULL DEFAULT 'individual',
      statement TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evidence_files (
      id TEXT PRIMARY KEY,
      dispute_id TEXT NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      declared_kind TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      extracted_text TEXT NOT NULL DEFAULT '',
      extraction_status TEXT NOT NULL DEFAULT 'pending',
      extraction_note TEXT NOT NULL DEFAULT '',
      uploaded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY,
      dispute_id TEXT NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
      engine TEXT NOT NULL,                -- 'heuristic' | 'openai-compatible' | 'heuristic (ai fallback)'
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      dispute_id TEXT NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', -- draft | reviewed | exported | submitted | failed
      analysis_id TEXT REFERENCES analyses(id),
      reviewed_at TEXT,
      submitted_at TEXT,
      submission_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      dispute_id TEXT,
      detail TEXT
    );
  `);

  const columns = db.prepare('PRAGMA table_info(evidence_files)').all().map((r) => r.name);
  for (const name of ['extracted_text', 'extraction_status', 'extraction_note']) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE evidence_files ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
  }
  return db;
}

export function audit(db, { actor, action, disputeId = null, detail = null }) {
  db.prepare(
    'INSERT INTO audit_log (ts, actor, action, dispute_id, detail) VALUES (?, ?, ?, ?, ?)'
  ).run(new Date().toISOString(), actor, action, disputeId, detail === null ? null : String(detail).slice(0, 1000));
}

export function auditForDispute(db, disputeId) {
  return db.prepare(
    'SELECT ts, actor, action, detail FROM audit_log WHERE dispute_id = ? ORDER BY id DESC LIMIT 50'
  ).all(disputeId);
}
