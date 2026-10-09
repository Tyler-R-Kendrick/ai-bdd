import { AiBddError, EXIT_CODES } from '@ai-bdd/contracts';

/** Maps a thrown error to the documented exit code (section 9.2). */
export function exitCodeFor(error: unknown): number {
  const payload = AiBddError.payload(error);
  switch (payload.group) {
    case 'config':
    case 'parse':
      return EXIT_CODES.usage;
    case 'driver':
    case 'model':
    case 'daemon':
      return EXIT_CODES.infrastructure;
    case 'resolution':
    case 'act':
    case 'assert':
    case 'evidence':
      return EXIT_CODES.failure;
    default:
      return payload.retryable ? EXIT_CODES.infrastructure : EXIT_CODES.failure;
  }
}

export { EXIT_CODES };
