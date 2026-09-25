import crypto from 'node:crypto';
import { inject } from 'vitest';

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
