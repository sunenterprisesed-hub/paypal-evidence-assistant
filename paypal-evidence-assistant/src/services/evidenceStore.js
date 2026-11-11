import fs from 'node:fs';
import path from 'node:path';
import { randomId, sha256Hex } from '../util/ids.js';
import { httpError } from '../util/http.js';
import { EVIDENCE_KINDS } from './requirements.js';

/**
 * Evidence file storage with defence in depth:
 * - extension allowlist + magic-byte sniffing (client MIME is never trusted)
 * - hard size cap enforced before and during the read (see util/http.readRawBody)
 * - server-generated random stored names; client filenames are display-only
 * - files stored outside any web root, served only via the download route
 *   with Content-Disposition: attachment and nosniff
 */

const TEXT_EXT = '.txt';
const ALLOWED = {
  '.pdf': { mime: 'application/pdf', magic: [Buffer.from('%PDF-', 'ascii')] },
  '.png': { mime: 'image/png', magic: [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])] },
  '.jpg': { mime: 'image/jpeg', magic: [Buffer.from([0xff, 0xd8, 0xff])] },
  '.jpeg': { mime: 'image/jpeg', magic: [Buffer.from([0xff, 0xd8, 0xff])] },
  [TEXT_EXT]: { mime: 'text/plain', text: true },
};

export function allowedExtensions() {
  return Object.keys(ALLOWED);
}

function hasMagic(buffer, magicBytes) {
  return magicBytes.some((magic) => buffer.subarray(0, magic.length).equals(magic));
}

function looksLikeText(buffer) {
  if (buffer.includes(0x00)) return false;
  const sample = buffer.subarray(0, 4096);
  let control = 0;
  for (const byte of sample) {
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control += 1;
  }
  return control / Math.max(sample.length, 1) < 0.01;
}

function sanitizeDisplayName(name) {
  const base = path.basename(String(name || '')).replace(/[^\w.()\- ]/g, '_').trim();
  return base.slice(0, 120) || 'file';
}

export class EvidenceStore {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.uploadsDir = path.join(config.dataDir, 'uploads');
  }

  listForDispute(disputeId) {
    return this.db.prepare(
      'SELECT id, dispute_id, original_name, mime, declared_kind, size, sha256, notes, extracted_text, extraction_status, extraction_note, uploaded_at FROM evidence_files WHERE dispute_id = ? ORDER BY uploaded_at ASC'
    ).all(disputeId);
  }

  get(fileId) {
    if (!/^[a-f0-9]{32}$/.test(String(fileId))) return null;
    return this.db.prepare('SELECT * FROM evidence_files WHERE id = ?').get(fileId) || null;
  }

  /**
   * Validates and stores one uploaded file.
   * @param {string} disputeId owning dispute (must exist; checked by caller)
   * @param {{originalName: string, declaredKind: string, notes?: string}} meta
   * @param {Buffer} buffer raw file bytes (already size-capped by the reader)
   */
  save(disputeId, meta, buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw httpError(400, 'Empty file');
    if (buffer.length > this.config.maxUploadBytes) throw httpError(413, 'File exceeds the maximum size');

    const originalName = sanitizeDisplayName(meta.originalName);
    const ext = path.extname(originalName).toLowerCase();
    const spec = ALLOWED[ext];
    if (!spec) {
      throw httpError(400, `File type "${ext || '(none)'}" is not allowed. Allowed: ${allowedExtensions().join(', ')}`);
    }
    if (spec.text) {
      if (!looksLikeText(buffer)) throw httpError(400, 'File does not look like plain text');
    } else if (!hasMagic(buffer, spec.magic)) {
      throw httpError(400, `File contents do not match the ${ext} format`);
    }

    const declaredKind = String(meta.declaredKind || '');
    if (!Object.hasOwn(EVIDENCE_KINDS, declaredKind)) {
      throw httpError(400, 'Unknown evidence kind');
    }

    const count = this.db.prepare('SELECT COUNT(*) AS n FROM evidence_files WHERE dispute_id = ?').get(disputeId).n;
    if (count >= this.config.maxFilesPerDispute) {
      throw httpError(400, `This case already has the maximum of ${this.config.maxFilesPerDispute} files`);
    }

    const id = randomId(16);
    const storedName = `${id}${ext}`;
    const filePath = path.join(this.uploadsDir, storedName);
    // 'wx' fails if the name somehow already exists.
    fs.writeFileSync(filePath, buffer, { flag: 'wx', mode: 0o600 });

    this.db.prepare(
      `INSERT INTO evidence_files (id, dispute_id, original_name, stored_name, mime, declared_kind, size, sha256, notes, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, disputeId, originalName, storedName, spec.mime, declaredKind, buffer.length, sha256Hex(buffer), String(meta.notes || '').slice(0, 500), new Date().toISOString());

    return this.get(id);
  }

  saveExtraction(fileId, extraction) {
    this.db.prepare('UPDATE evidence_files SET extracted_text = ?, extraction_status = ?, extraction_note = ? WHERE id = ?')
      .run(extraction.text, extraction.status, extraction.note, fileId);
  }

  /** Returns { row, absolutePath } after verifying the path stays in uploadsDir. */
  resolveForDownload(fileId) {
    const row = this.get(fileId);
    if (!row) return null;
    const resolved = path.resolve(this.uploadsDir, row.stored_name);
    if (!resolved.startsWith(path.resolve(this.uploadsDir) + path.sep)) {
      throw httpError(500, 'Invalid storage path', false);
    }
    return { row, absolutePath: resolved };
  }

  remove(fileId) {
    const found = this.resolveForDownload(fileId);
    if (!found) return false;
    this.db.prepare('DELETE FROM evidence_files WHERE id = ?').run(fileId);
    try { fs.unlinkSync(found.absolutePath); } catch { /* already gone */ }
    return true;
  }
}
