import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';

// Files on the local disk under one root folder. The calls are the ones an S3
// bucket would answer as well, so moving attachments off the server's disk at
// deploy time means a second implementation of these three, and nothing else.
//
//   put(key, content)  stores a Buffer under key, replacing what was there
//   open(key)          -> { size, stream }, or null when nothing is stored
//   remove(key)        deletes, and is fine with nothing being there
//
// Keys are made by Sift, never taken from a filename in a message, and a key
// that would resolve outside the root is refused all the same.
export function diskStorage(root) {
  const base = path.resolve(root);

  function locate(key) {
    const full = path.resolve(base, key);
    if (!full.startsWith(base + path.sep)) throw new Error(`storage key escapes the storage root: ${key}`);
    return full;
  }

  return {
    async put(key, content) {
      const full = locate(key);
      await mkdir(path.dirname(full), { recursive: true });
      // Written beside the target and moved into place, so a crash halfway
      // leaves a stray part file rather than a truncated attachment.
      const partial = `${full}.${crypto.randomUUID()}.part`;
      await writeFile(partial, content);
      await rename(partial, full);
    },

    // Opened before anything is sent, so a missing file can still become a
    // 404 instead of a download that stops at zero bytes.
    async open(key) {
      let handle;
      try {
        handle = await open(locate(key), 'r');
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
      const { size } = await handle.stat();
      return { size, stream: handle.createReadStream() };
    },

    async remove(key) {
      await rm(locate(key), { force: true });
    },
  };
}
