// author @woutvanhemelrijck
// date: 27/11/2025
import { describe, it, expect } from 'vitest';
import { EncryptionService } from '../auth/encryption-service.mjs';

describe('EncryptionService', () => {
  // Gebruik een geldige master key voor alle "happy path" tests
  const hexKey = EncryptionService.generateMasterKey();
  const service = EncryptionService.fromHexKey(hexKey);

  it('encrypts and decrypts back to the original data', () => {
    const original = Buffer.from('Hello, encrypted world! äöü 🚀', 'utf8');

    const encrypted = service.encrypt(original);
    const decrypted = service.decrypt(encrypted);

    expect(decrypted.equals(original)).toBe(true);
  });

  it('uses a random IV for each encryption call', () => {
    const data = Buffer.from('same plaintext', 'utf8');

    const encrypted1 = service.encrypt(data);
    const encrypted2 = service.encrypt(data);

    const iv1 = encrypted1.subarray(0, 16); // eerste 16 bytes = IV
    const iv2 = encrypted2.subarray(0, 16);

    // IV’s mogen niet gelijk zijn
    expect(iv1.equals(iv2)).toBe(false);
  });

  it('throws if master key is not 32 bytes (fromBuffer)', () => {
    const badKey = Buffer.alloc(16); // 16 bytes i.p.v. 32

    expect(() => EncryptionService.fromBuffer(badKey)).toThrowError(/Master key must be 32 bytes \(256 bits\)/);
  });

  it('can be constructed from a valid hex key (fromHexKey)', () => {
    const key = EncryptionService.generateMasterKey(); // 64 hex chars → 32 bytes
    const serviceFromHex = EncryptionService.fromHexKey(key);

    const data = Buffer.from('test', 'utf8');
    const encrypted = serviceFromHex.encrypt(data);
    const decrypted = serviceFromHex.decrypt(encrypted);

    expect(decrypted.equals(data)).toBe(true);
  });

  it('throws on tampered ciphertext/auth tag', () => {
    const data = Buffer.from('secret message', 'utf8');
    const encrypted = service.encrypt(data);

    const tampered = Buffer.from(encrypted);
    // Flip een bit ergens in de auth tag (na IV)
    tampered[16] = tampered[16] ^ 0xff;

    expect(() => service.decrypt(tampered)).toThrowError(/Decryption failed/);
  });
});
