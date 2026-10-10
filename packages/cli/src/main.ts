import { notImplemented, type ExitCode } from '@ai-bdd/sdk/contracts';
export interface CliIo { stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown }; env: Record<string, string | undefined>; cwd: string }
export function main(_argv: string[], _io?: Partial<CliIo>): Promise<ExitCode> { return notImplemented('cli.main'); }
