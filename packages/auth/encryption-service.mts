// author @woutvanhemelrijck
// date: 24/11/2025
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_SIZE = 16; // 128 bits
const AUTH_TAG_SIZE = 16; // 128 bits

export class EncryptionService {
  private masterKey: Buffer;

  private constructor(masterKey: Buffer) {
    //key is 32 bytes (256 bits)
    if (masterKey.length !== 32) {
      throw new Error('Master key must be 32 bytes (256 bits)');
    }
    this.masterKey = masterKey;
  }

  /**
   * Initialiseer EncryptionService met master key
   * Master key kan uit env variable komen: process.env.ENCRYPTION_KEY
   */
  static fromHexKey(hexKey: string): EncryptionService {
    const masterKey = Buffer.from(hexKey, 'hex');
    return new EncryptionService(masterKey);
  }

  static fromBuffer(keyBuffer: Buffer): EncryptionService {
    return new EncryptionService(keyBuffer);
  }

  /**
   * Genereer eenmalig random 256-bit master key
   */
  static generateMasterKey(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Versleutel data met AES-256-GCM
   * Format: [IV (16 bytes)][AUTH_TAG (16 bytes)][CIPHERTEXT](variabel)
   */
  encrypt(data: Buffer): Buffer {
    const iv = crypto.randomBytes(IV_SIZE);
    const cipher = crypto.createCipheriv(ALGORITHM, this.masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Combineer: IV + AUTH_TAG + CIPHERTEXT
    return Buffer.concat([iv, authTag, encrypted]);
  }

  decrypt(encryptedData: Buffer): Buffer {
    // Extraheer componenten
    const iv = encryptedData.subarray(0, IV_SIZE);
    const authTag = encryptedData.subarray(IV_SIZE, IV_SIZE + AUTH_TAG_SIZE);
    const ciphertext = encryptedData.subarray(IV_SIZE + AUTH_TAG_SIZE);

    // Maak decipher
    const decipher = crypto.createDecipheriv(ALGORITHM, this.masterKey, iv);
    decipher.setAuthTag(authTag);

    try {
      // Ontsleutel
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return decrypted;
    } catch (error) {
      throw new Error(`Decryption failed: ${(error as Error).message}`);
    }
  }
}
