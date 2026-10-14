import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { afterAll } from 'vitest';

// Points the Atlas tests at a database of their own on the cluster in
// MONGO_URI_ATLAS, never at the one the app uses: the name always ends in
// _test, and the tests empty it when they finish. Everything else is set the
// way tests/setup/env.js sets it.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fromFile = parse(readFileSync(path.join(root, '.env')));
if (!fromFile.MONGO_URI_ATLAS) throw new Error('npm run test:atlas needs MONGO_URI_ATLAS in .env');

const uri = new URL(fromFile.MONGO_URI_ATLAS);
uri.pathname = '/sift_atlas_test';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.MONGO_URI = uri.toString();
process.env.CLIENT_ORIGIN = 'http://localhost:5173';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-long-enough-for-the-schema';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-long-enough-for-the-schema';
for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM', 'IMAP_HOST', 'IMAP_USER', 'IMAP_PASSWORD', 'IMAP_OWNER']) {
  process.env[key] = '';
}
process.env.OLLAMA_HOST = 'http://127.0.0.1:9';
process.env.EMBEDDING_MODEL = 'bge-m3';
const attachmentDir = mkdtempSync(path.join(os.tmpdir(), 'sift-atlas-attachments-'));
process.env.ATTACHMENT_DIR = attachmentDir;
afterAll(() => rmSync(attachmentDir, { recursive: true, force: true }));
