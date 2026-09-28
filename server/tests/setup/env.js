import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, inject } from 'vitest';

// Runs before each test file is imported, so everything here is in place
// before src/config/env.js parses process.env. Every key the schema reads is
// set explicitly: dotenv never overrides a variable that already exists, so a
// developer's own .env cannot leak into a run.
process.env.NODE_ENV = 'test';
process.env.PORT = '4000';
process.env.LOG_LEVEL = 'silent';
process.env.CLIENT_ORIGIN = 'http://localhost:5173';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-long-enough-for-the-schema';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-long-enough-for-the-schema';
process.env.ACCESS_TOKEN_TTL = '15m';
process.env.REFRESH_TOKEN_TTL = '30d';
process.env.MONGO_URI = `${inject('mongoUri')}sift_test_${crypto.randomUUID().slice(0, 8)}`;
// Empty, which the schema reads as unset. A developer's real SMTP details in
// .env must never turn a test run into mail going out, nor real IMAP details
// into a test run reading someone's mailbox.
for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM']) process.env[key] = '';
// The same for IMAP. Tests hand the importer a fake mailbox instead.
for (const key of ['IMAP_HOST', 'IMAP_PORT', 'IMAP_USER', 'IMAP_PASSWORD', 'IMAP_OWNER']) process.env[key] = '';

// Attachment files go to a folder of this test file's own, removed afterwards,
// never to the data folder a developer's own mail is in.
const attachmentDir = mkdtempSync(path.join(os.tmpdir(), 'sift-attachments-'));
process.env.ATTACHMENT_DIR = attachmentDir;
process.env.ATTACHMENT_MAX_MB = '1';
afterAll(() => rmSync(attachmentDir, { recursive: true, force: true }));

// Model calls in tests go to a fake Ollama each test starts itself. This
// address has nothing listening, so a call that reaches for the real one
// fails at once instead of running a model on the developer's machine.
process.env.AI_PROVIDER = 'ollama';
process.env.OLLAMA_HOST = 'http://127.0.0.1:9';
process.env.EMBEDDING_MODEL = 'bge-m3';
process.env.CHAT_MODEL = 'test-chat-model';
