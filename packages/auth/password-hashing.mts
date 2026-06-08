// @author Wout Van Hemelrijck
// @date 2025-11-29

import argon2, { argon2id } from 'argon2';

interface Argon2Options {
  type: typeof argon2id;
  timeCost: number;
  memoryCost: number;
  parallelism: number;
  raw?: false;
}

/**
 * Default Argon2id parameters.
 *
 * Argon2 genereert zelf voor elke hash een willekeurige salt en
 * stopt die samen met de parameters in de resulterende hash-string.
 * Die ene string is alles wat je in je database moet bewaren.
 */
const DEFAULT_ARGON2_OPTIONS: Argon2Options = {
  type: argon2id,
  timeCost: 3, // aantal iteraties (hoger = trager = veiliger)
  memoryCost: 2 ** 16, // 64 MiB RAM
  parallelism: 1, // aantal threads
  raw: false, // standaard hash string output
};

/**
 * Service-klasse voor het hashen en verifiëren van wachtwoorden
 * met Argon2id.
 */
export class PasswordHasher {
  private readonly options: Argon2Options;

  constructor(overrides: Partial<Argon2Options> = {}) {
    this.options = { ...DEFAULT_ARGON2_OPTIONS, ...overrides };
  }

  /**
   * Hash een plain-text password met Argon2id.
   *
   * @param plainPassword - Het oorspronkelijke wachtwoord van de gebruiker.
   * @returns Een Argon2-hashstring (inclusief salt & parameters).
   */
  async hashPassword(plainPassword: string): Promise<string> {
    if (typeof plainPassword !== 'string' || plainPassword.length === 0) {
      throw new Error('Password must be a non-empty string');
    }

    // Argon2 maakt hier zelf een unieke random salt aan.
    // De salt wordt in de hash-string gecodeerd.
    return argon2.hash(plainPassword, this.options);
  }

  /**
   * Verifieer of een plain-text password overeenkomt met een
   * eerder opgeslagen Argon2-hash.
   *
   * @param plainPassword - Kandidaten-wachtwoord (user input).
   * @param hash - De eerder opgeslagen Argon2-hashstring uit de database.
   * @returns true als het wachtwoord klopt, anders false.
   */
  async verifyPassword(plainPassword: string, hash: string): Promise<boolean> {
    if (
      typeof plainPassword !== 'string' ||
      plainPassword.length === 0 ||
      typeof hash !== 'string' ||
      hash.length === 0
    ) {
      return false;
    }

    try {
      // Argon2 leest zelf de salt + parameters uit de hash-string.
      return await argon2.verify(hash, plainPassword);
    } catch {
      // Bij corrupte hash of verkeerde parameters → gewoon false teruggeven.
      return false;
    }
  }
}
