import crypto from 'node:crypto';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Thrown by putStream when a stream carries more than its limit.
export class TooLarge extends Error {
  constructor(limit) {
    super(`more than ${limit} bytes`);
    this.code = 'TOO_LARGE';
    this.limit = limit;
  }
}

// Passes bytes through and counts them, and fails the stream as soon as there
// are more than `limit`, so an upload over the limit stops there rather than
// filling the disk first and being refused afterwards.
function byteLimit(limit) {
  let seen = 0;
  const counter = new Transform({
    transform(chunk, encoding, callback) {
      seen += chunk.length;
      if (seen > limit) callback(new TooLarge(limit));
      else callback(null, chunk);
    },
  });
  return { counter, size: () => seen };
}

// Files on the local disk under one root folder. The calls are the ones an S3
// bucket would answer as well, so moving attachments off the server's disk at
// deploy time means a second implementation of these three, and nothing else.
//
//   put(key, content)             stores a Buffer under key, replacing what was there
//   putStream(key, stream, limit) the same from a stream -> { size }, or TooLarge
//   copy(fromKey, toKey)          a second, independent copy of a stored file
//   open(key)                     -> { size, stream }, or null when nothing is stored
//   remove(key)                   deletes, and is fine with nothing being there
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

    async putStream(key, stream, { limit }) {
      const full = locate(key);
      await mkdir(path.dirname(full), { recursive: true });
      const partial = `${full}.${crypto.randomUUID()}.part`;
      const { counter, size } = byteLimit(limit);
      try {
        await pipeline(stream, counter, createWriteStream(partial));
      } catch (err) {
        await rm(partial, { force: true });
        throw err;
      }
      await rename(partial, full);
      return { size: size() };
    },

    async copy(fromKey, toKey) {
      const target = locate(toKey);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(locate(fromKey), target);
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
