// @author Wout Van Hemelrijck
// @date 2025-12-03

import { describe, it, expect } from 'vitest';
import { PasswordHasher } from '../auth/password-hashing.mjs';

describe('PasswordHasher', () => {
  const password = 'MyDirtyLittleSecret123!';
  const wrongPassword = 'JonesBarbequeAndFootMassage';

  it('should hash a password and return a non-empty string', async () => {
    const hasher = new PasswordHasher();
    const hash = await hasher.hashPassword(password);

    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(10);
    expect(hash).not.toBe(password);
  });

  it('should throw an error for an empty password', async () => {
    const hasher = new PasswordHasher();

    await expect(hasher.hashPassword('')).rejects.toThrow('Password must be a non-empty string');
  });

  it('should throw an error when password is not a string', async () => {
    const hasher = new PasswordHasher();

    // @ts-expect-error – intentionally wrong type
    await expect(hasher.hashPassword(1234)).rejects.toThrow();
  });

  it('should produce different hashes for the same password (random salt)', async () => {
    const hasher = new PasswordHasher();

    const hash1 = await hasher.hashPassword(password);
    const hash2 = await hasher.hashPassword(password);

    expect(hash1).not.toBe(hash2);
  });

  it('should correctly verify a valid password', async () => {
    const hasher = new PasswordHasher();

    const hash = await hasher.hashPassword(password);
    const result = await hasher.verifyPassword(password, hash);

    expect(result).toBe(true);
  });

  it('should reject an invalid password', async () => {
    const hasher = new PasswordHasher();

    const hash = await hasher.hashPassword(password);
    const result = await hasher.verifyPassword(wrongPassword, hash);

    expect(result).toBe(false);
  });

  it('should return false when verifying an empty password', async () => {
    const hasher = new PasswordHasher();
    const hash = await hasher.hashPassword(password);

    const result = await hasher.verifyPassword('', hash);
    expect(result).toBe(false);
  });

  it('should return false when verifying with an empty hash', async () => {
    const hasher = new PasswordHasher();

    const result = await hasher.verifyPassword(password, '');
    expect(result).toBe(false);
  });

  it('should return false when verifying a corrupted hash string', async () => {
    const hasher = new PasswordHasher();

    const hash = await hasher.hashPassword(password);
    const corrupted = hash.slice(0, -10) + 'XYZ123';

    const result = await hasher.verifyPassword(password, corrupted);
    expect(result).toBe(false);
  });

  it('should allow overriding Argon2 parameters', async () => {
    const hasher = new PasswordHasher({
      timeCost: 1,
      memoryCost: 2 ** 15,
      parallelism: 2,
    });

    const hash = await hasher.hashPassword(password);

    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(10);

    const result = await hasher.verifyPassword(password, hash);
    expect(result).toBe(true);
  });

  it('should not break when verify is called with non-string input', async () => {
    const hasher = new PasswordHasher();

    // @ts-expect-error – wrong type on purpose
    const r1 = await hasher.verifyPassword(1337, 'hash');
    expect(r1).toBe(false);

    // @ts-expect-error – wrong type on purpose
    const r2 = await hasher.verifyPassword('password', 1337);
    expect(r2).toBe(false);
  });
});
