import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { HttpError } from '../store.ts';
export class CredentialVault {
  private key: Buffer;
  readonly keyId: string;
  constructor(encoded: string) {
    if (!/^[A-Za-z0-9_-]{43}=?$/.test(encoded))
      throw new Error(
        'Repository token encryption requires a 32-byte base64url key',
      );
    this.key = Buffer.from(encoded, 'base64url');
    if (this.key.length !== 32)
      throw new Error(
        'Repository token encryption requires a 32-byte base64url key',
      );
    this.keyId = createHash('sha256')
      .update(this.key)
      .digest('hex')
      .slice(0, 16);
  }
  seal(value: string, userId: string, purpose: string): string {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`studio/repository/v1/${userId}/${purpose}`));
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    return [
      'v1',
      this.keyId,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }
  open(encoded: string, userId: string, purpose: string): string {
    try {
      const [version, keyId, iv, tag, ciphertext, ...rest] = encoded.split('.');
      if (
        version !== 'v1' ||
        keyId !== this.keyId ||
        !iv ||
        !tag ||
        ciphertext === undefined ||
        rest.length
      )
        throw new Error();
      const nonce = Buffer.from(iv, 'base64url'),
        auth = Buffer.from(tag, 'base64url');
      if (nonce.length !== 12 || auth.length !== 16) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAAD(Buffer.from(`studio/repository/v1/${userId}/${purpose}`));
      decipher.setAuthTag(auth);
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new HttpError(
        503,
        'Stored repository credentials could not be decrypted with this deployment key',
      );
    }
  }
}
