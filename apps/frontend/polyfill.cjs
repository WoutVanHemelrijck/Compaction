// Polyfill for Node < 20.12.0: adds crypto.hash() which Vite 7 requires
const crypto = require('crypto');
if (typeof crypto.hash !== 'function') {
  crypto.hash = (algorithm, data, outputEncoding) =>
    crypto
      .createHash(algorithm)
      .update(data)
      .digest(outputEncoding || 'hex');
}
