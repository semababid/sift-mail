import { env } from '../../config/env.js';
import { diskStorage } from './disk.js';

export const storage = diskStorage(env.ATTACHMENT_DIR);

export { TooLarge } from './disk.js';

// The most a message's attachments may add up to. A single limit for the
// whole message rather than each file, because that is what an SMTP server
// refuses.
export const MAX_ATTACHMENT_BYTES = env.ATTACHMENT_MAX_MB * 1024 * 1024;

// One key per attachment: whose, which message, which attachment on it.
export const attachmentKey = (userId, messageId, attachmentId) => `${userId}/${messageId}/${attachmentId}`;
