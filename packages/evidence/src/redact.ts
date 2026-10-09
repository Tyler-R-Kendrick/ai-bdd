import type { Redactor } from '@ai-bdd/contracts';
import { AiBddError } from '@ai-bdd/contracts';

export interface SecretDeclaration {
  value?: string;
  env?: string;
}

/** Every form a secret can take in text, logs and URLs. */
export function secretVariants(value: string): string[] {
  const variants = [value, encodeURIComponent(value)];
  try {
    variants.push(Buffer.from(value, 'utf8').toString('base64'));
  } catch {
    // ignore
  }
  return [...new Set(variants.filter((variant) => variant.length >= 4))];
}

/**
 * Values shorter than 4 characters are rejected at config load (SECRET_TOO_SHORT)
 * so that redaction cannot blank out unrelated text.
 */
export function resolveSecrets(
  secrets: Record<string, SecretDeclaration>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, declaration] of Object.entries(secrets)) {
    const value = declaration.value ?? (declaration.env ? env[declaration.env] : undefined);
    if (value === undefined || value.length === 0) continue;
    if (value.length < 4) {
      throw new AiBddError('SECRET_TOO_SHORT', `secret \`${name}\` is shorter than 4 characters`, { details: { name } });
    }
    resolved[name] = value;
  }
  return resolved;
}

/** Replaces every declared secret (and its encodings) with `<secret:name>`. */
export function createRedactor(
  secrets: Record<string, SecretDeclaration | string>,
  env: NodeJS.ProcessEnv = process.env,
): Redactor {
  const values: Array<{ name: string; variants: string[] }> = [];
  for (const [name, declaration] of Object.entries(secrets)) {
    const value = typeof declaration === 'string' ? declaration : (declaration.value ?? (declaration.env ? env[declaration.env] : undefined));
    if (value === undefined || value.length < 4) continue;
    values.push({ name, variants: secretVariants(value) });
  }

  const redact = (text: string): string => {
    let out = text;
    for (const secret of values) {
      for (const variant of secret.variants) {
        if (variant.length >= 4 && out.includes(variant)) out = out.split(variant).join(`<secret:${secret.name}>`);
      }
    }
    return out;
  };

  return {
    redact,
    redactJson<T>(value: T): T {
      return JSON.parse(redact(JSON.stringify(value))) as T;
    },
    names(): string[] {
      return values.map((secret) => secret.name);
    },
  };
}

export function redactValue(redactor: Redactor | undefined, text: string): string {
  return redactor ? redactor.redact(text) : text;
}
