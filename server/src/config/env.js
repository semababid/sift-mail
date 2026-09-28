import { config } from 'dotenv';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
config({ path: path.join(root, '.env'), quiet: true });

// The units jsonwebtoken accepts for expiresIn.
const ttl = z.string().regex(/^\d+[smhd]$/, 'use a number followed by s, m, h or d, like 15m');

// Keys are added to this schema as the stages that need them land, so a missing
// one fails at boot rather than at the first request that happens to use it.
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
    CLIENT_ORIGIN: z.url().default('http://localhost:5173'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    ACCESS_TOKEN_TTL: ttl.default('15m'),
    REFRESH_TOKEN_TTL: ttl.default('30d'),

    // Outbound mail. All optional: without a host, mail to addresses outside
    // Sift is stored but goes nowhere, which is enough for local development
    // against seeded contacts.
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(465),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    // The address mail leaves from. Providers refuse a From that is not the
    // mailbox they authenticated, so this is one address for every user, with
    // each user's name on it.
    SMTP_FROM: z.email().optional(),

    // Inbound mail over IMAP, for scripts/imap-sync.js. IMAP_OWNER is the Sift
    // account the synced mail is filed under: one mailbox, one owner, which is
    // as far as credentials kept in .env can honestly go.
    IMAP_HOST: z.string().min(1).optional(),
    IMAP_PORT: z.coerce.number().int().positive().default(993),
    IMAP_USER: z.string().min(1).optional(),
    IMAP_PASSWORD: z.string().min(1).optional(),
    IMAP_OWNER: z.email().optional(),

    // The model service for search, triage, summaries and the inbox chat.
    // "hosted" is only a placeholder until stage 10.3.
    AI_PROVIDER: z.enum(['ollama', 'hosted']).default('ollama'),
    OLLAMA_HOST: z.url().default('http://localhost:11434'),
    EMBEDDING_MODEL: z.string().min(1).default('bge-m3'),
    CHAT_MODEL: z.string().min(1).default('qwen3.5:9b'),

    // Where attachment files are kept, and the size limit. A message being
    // sent may carry this much in all. An imported file over it is listed on
    // its message but not stored. Gmail refuses a message over 25 MB once it
    // is encoded, which leaves room for about 18 MB of files.
    ATTACHMENT_DIR: z.string().min(1).default(path.join(root, 'data', 'attachments')),
    ATTACHMENT_MAX_MB: z.coerce.number().positive().default(25),
  })
  .refine((v) => v.JWT_ACCESS_SECRET !== v.JWT_REFRESH_SECRET, {
    path: ['JWT_REFRESH_SECRET'],
    message: 'must differ from JWT_ACCESS_SECRET, or an access token can be used as a refresh token',
  })
  .refine((v) => !v.SMTP_HOST || v.SMTP_FROM, {
    path: ['SMTP_FROM'],
    message: 'is required when SMTP_HOST is set',
  })
  .refine((v) => !v.SMTP_USER === !v.SMTP_PASSWORD, {
    path: ['SMTP_PASSWORD'],
    message: 'SMTP_USER and SMTP_PASSWORD go together',
  })
  .refine((v) => !v.IMAP_HOST || (v.IMAP_USER && v.IMAP_PASSWORD && v.IMAP_OWNER), {
    path: ['IMAP_HOST'],
    message: 'IMAP_USER, IMAP_PASSWORD and IMAP_OWNER are all needed once IMAP_HOST is set',
  });

// A key left empty in .env, as the example file ships them, means "not set".
// Without this, SMTP_HOST= would count as a host of no characters.
const given = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== ''));
const parsed = schema.safeParse(given);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`Bad environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
