import { env } from '../../config/env.js';
import { diskStorage } from './disk.js';

export const storage = diskStorage(env.ATTACHMENT_DIR);

export const MAX_ATTACHMENT_BYTES = env.ATTACHMENT_MAX_MB * 1024 * 1024;

// One key per attachment: whose, which message, which position on it. The
// same message and position always give the same key, so storing a message's
// attachments a second time replaces files rather than adding more.
export const attachmentKey = (userId, messageId, index) => `${userId}/${messageId}/${index}`;
