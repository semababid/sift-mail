import crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { User } from '../models/index.js';
import { conflict, unauthorized } from '../lib/errors.js';

// OWASP's argon2id baseline: 19 MiB, two passes, one lane.
const ARGON = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

// A real hash of a throwaway string, verified against when no user was found so
// that a login for a missing address does the same work as a login for a real
// one. Without it the response time tells an attacker which addresses exist.
const DECOY_HASH = await hash(crypto.randomUUID(), ARGON);

export async function register({ email, password, name }) {
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) throw conflict('an account with that email already exists', 'email_taken');

  const passwordHash = await hash(password, ARGON);
  return User.create({ email, passwordHash, name });
}

export async function login({ email, password }) {
  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');

  // Hash even when the user does not exist, so a missing account and a wrong
  // password take the same time and the endpoint cannot be used to find out
  // which addresses are registered.
  let ok = false;
  try {
    ok = await verify(user?.passwordHash ?? DECOY_HASH, password);
  } catch {
    ok = false;
  }

  if (!user || !ok) throw unauthorized('email or password is wrong', 'bad_credentials');
  return user;
}
