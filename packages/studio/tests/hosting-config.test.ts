import { describe, expect, it } from 'vitest';
import {
  hostingConfigFromEnv,
  hostingDiagnostics,
} from '../server/hosting/config.ts';
const configured = {
  VERCEL: '1',
  VERCEL_ENV: 'production',
  VERCEL_PROJECT_PRODUCTION_URL: 'studio.example.test',
  DATABASE_URL:
    'postgresql://fixture-user:fixture-password@db.example.test/studio?sslmode=require',
  BLOB_READ_WRITE_TOKEN: 'test-only-blob-binding',
};
describe('replaceable hosting configuration', () => {
  it('selects external durable services and disposable staging in Vercel', () => {
    const config = hostingConfigFromEnv(configured);
    expect(config.provider).toBe('vercel');
    expect(config.database.adapter).toBe('postgres');
    expect(config.stagingDirectory).toBe('/tmp/studio-staging');
    expect(config.port).toBe(80);
    const report = JSON.stringify(hostingDiagnostics(config));
    expect(report).not.toContain('fixture-password');
    expect(report).not.toContain('test-only-blob-binding');
    expect(report).not.toContain('DATABASE_URL');
  });
  it('uses a deployment-owned preview origin without trusting request Host headers', () => {
    expect(
      hostingConfigFromEnv({
        ...configured,
        VERCEL_ENV: 'preview',
        VERCEL_URL: 'studio-preview.vercel.app',
        STUDIO_ORIGIN: 'https://studio.example.test',
      }).origin,
    ).toBe('https://studio-preview.vercel.app');
    expect(() =>
      hostingConfigFromEnv({
        ...configured,
        STUDIO_ORIGIN: 'https://user:pass@example.test',
      }),
    ).toThrow('canonical');
  });
  it('refuses missing SQL/private objects, ephemeral SQLite, demo mode, and emulator endpoints in cloud', () => {
    expect(() =>
      hostingConfigFromEnv({ ...configured, DATABASE_URL: '' }),
    ).toThrow('DATABASE_URL');
    expect(() =>
      hostingConfigFromEnv({
        ...configured,
        DATABASE_URL: 'file:/tmp/studio.sqlite',
      }),
    ).toThrow('PostgreSQL');
    expect(() =>
      hostingConfigFromEnv({ ...configured, BLOB_READ_WRITE_TOKEN: '' }),
    ).toThrow('private Blob');
    expect(() =>
      hostingConfigFromEnv({ ...configured, STUDIO_STORAGE_ADAPTER: 'sqlite' }),
    ).toThrow('PostgreSQL');
    expect(() =>
      hostingConfigFromEnv({ ...configured, STUDIO_DEMO: '1' }),
    ).toThrow('forbidden');
    expect(() =>
      hostingConfigFromEnv({
        ...configured,
        VERCEL_BLOB_API_URL: 'http://127.0.0.1:9999',
      }),
    ).toThrow('emulators');
  });
  it('keeps the local adapter independently usable without cloud account bindings', () => {
    const config = hostingConfigFromEnv({
      STUDIO_DATA_DIR: '/tmp/hosting-config-fixture',
      STUDIO_HOSTING_PROVIDER: 'node',
    });
    expect(config.database).toEqual({
      adapter: 'sqlite',
      file: '/tmp/hosting-config-fixture/studio.sqlite',
    });
    expect(config.jobs).toEqual({ adapter: 'local' });
    expect(() =>
      hostingConfigFromEnv({ STUDIO_HOSTING_PROVIDER: 'uninstalled-cloud' }),
    ).toThrow('Unknown');
  });
});
