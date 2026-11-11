import { execFile } from 'node:child_process';

const LIMIT = 40000;
let active = 0;

function runRestricted(buffer, command, commandArgs) {
  const args = [
    '--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
    '--setenv', 'PATH', '/usr/bin', '--setenv', 'LANG', 'C.UTF-8',
    '--ro-bind', '/usr/bin', '/usr/bin', '--ro-bind', '/usr/lib', '/usr/lib',
    '--ro-bind', '/usr/share/tesseract-ocr', '/usr/share/tesseract-ocr',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev',
    '--tmpfs', '/tmp', '--chdir', '/tmp', '--',
    '/usr/bin/prlimit', '--as=536870912', '--cpu=8', '--fsize=1048576', '--nofile=64', '--',
    command, ...commandArgs,
  ];
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/bwrap', args, {
      env: {}, timeout: 12000, maxBuffer: 128 * 1024,
      killSignal: 'SIGKILL', encoding: 'utf8',
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.on('error', () => {});
    child.stdin.end(buffer);
  });
}

/**
 * Untrusted parsing runs in a separate OS sandbox with no network or app/home
 * mounts, a cleared environment, and CPU/memory/output/time limits. Input is
 * supplied only by stdin. Never fall back to unrestricted execution.
 */
export async function extractDocumentText(buffer, mime) {
  if (mime === 'text/plain') return { status: 'text', text: buffer.toString('utf8').slice(0, LIMIT), note: 'Plain text, not authenticated evidence.' };
  if (!['application/pdf', 'image/png', 'image/jpeg'].includes(mime)) return { status: 'unsupported', text: '', note: 'Unsupported content type.' };
  if (active >= 2) return { status: 'busy', text: '', note: 'Extractor busy. Re-upload when extraction capacity is available.' };
  active++;
  const isPdf = mime === 'application/pdf';
  try {
    let text = await runRestricted(buffer, isPdf ? '/usr/bin/pdftotext' : '/usr/bin/tesseract', isPdf
      ? ['-f', '1', '-l', '20', '-enc', 'UTF-8', '-', '-']
      : ['stdin', 'stdout', '-l', 'eng']);
    let usedOcr = !isPdf;
    if (isPdf && !text.trim()) {
      // This is a fixed program, not a shell assembled from filenames or text.
      // All output files exist only inside the throwaway namespace's /tmp.
      const scannedPdfProgram = 'set -eu; pdftoppm -f 1 -l 3 -r 120 -png - /tmp/page; for image in /tmp/page-*.png; do tesseract "$image" stdout -l eng; done';
      text = await runRestricted(buffer, '/usr/bin/sh', ['-c', scannedPdfProgram]);
      usedOcr = true;
    }
    const clean = text.replace(/\u0000/g, '').slice(0, LIMIT).trim();
    return clean
      ? { status: usedOcr ? 'ocr' : 'pdf_text', text: clean, note: usedOcr ? `${isPdf ? 'Scanned PDF: first 3 pages only. ' : ''}English OCR can misread characters. Compare with the original.` : 'PDF text: first 20 pages maximum; contents are unverified.' }
      : { status: 'empty', text: '', note: 'No readable text found within the extraction limits. Manual review is needed.' };
  } catch {
    return { status: 'failed', text: '', note: 'Restricted extraction failed or exceeded limits. Contents remain unread; no unsafe fallback was used.' };
  } finally { active--; }
}


/** Deployment preflight: verify the exact parser isolation path, not a claim. */
export async function extractionPreflight() {
  try {
    const result = await runRestricted(Buffer.alloc(0), '/usr/bin/sh', ['-c', 'test ! -e /home && test ! -e /opt && test ! -e /app && test ! -e /var && test -z "$HOME" && printf isolated']);
    return result === 'isolated';
  } catch { return false; }
}
