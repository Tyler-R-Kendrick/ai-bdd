import { describe, expect, it } from 'vitest';
import { managedT3SettingsFromEnv } from '../server/local/managed-t3-settings.ts';
import { integrationSettingsFromEnv } from '../server/integrations/settings.ts';

const fixtureSecret = 'managed-t3-fixture-not-a-real-secret-0123456789';
const configured = {
  NODE_ENV: 'production',
  STUDIO_LOCAL_MODEL_DIR: '/opt/studio-model',
  STUDIO_T3_MANAGED_TOOLS_DIR: '/opt/studio-native',
  STUDIO_JOB_SECRET: fixtureSecret,
};
describe('operator-owned managed native T3 settings', () => {
  it('keeps authoring available without optional native configuration and rejects unsafe directories', () => {
    expect(managedT3SettingsFromEnv({}, true)).toBeUndefined();
    expect(managedT3SettingsFromEnv(configured, false)).toBeUndefined();
    expect(managedT3SettingsFromEnv({ ...configured, STUDIO_JOB_SECRET: undefined }, true)).toBeUndefined();
    expect(() => managedT3SettingsFromEnv({ ...configured, STUDIO_T3_MANAGED_TOOLS_DIR: 'relative' }, true)).toThrow('absolute');
    expect(() => managedT3SettingsFromEnv({ ...configured, STUDIO_T3_MANAGED_STATE_DIR: 'relative' }, true)).toThrow('absolute');
    expect(() => managedT3SettingsFromEnv({ ...configured, STUDIO_JOB_SECRET: 'too-short' }, true)).toThrow('at least32');
  });
  it('derives a stable purpose-scoped key and excludes it from serialized settings', () => {
    const first = managedT3SettingsFromEnv(configured, true)!;
    const second = managedT3SettingsFromEnv(configured, true)!;
    expect(first.key.byteLength).toBe(32);
    expect(first.key).toEqual(second.key);
    expect(Buffer.from(first.key).toString('hex')).not.toBe(Buffer.from(fixtureSecret).toString('hex'));
    const other = managedT3SettingsFromEnv({ ...configured, STUDIO_JOB_SECRET: fixtureSecret + '-other-environment' }, true)!;
    expect(other.key).not.toEqual(first.key);
    expect(JSON.stringify(first)).toBe('{"toolsDirectory":"/opt/studio-native"}');
    expect(JSON.stringify(first)).not.toContain(fixtureSecret);
    expect(Object.isFrozen(first)).toBe(true);
  });
  it('supports checkpoint key rotation and enforces production pricing and HTTPS boundaries', () => {
    const explicit = managedT3SettingsFromEnv({ ...configured, STUDIO_T3_STATE_KEY: fixtureSecret + '-dedicated' }, true)!;
    expect(explicit.key).not.toEqual(managedT3SettingsFromEnv(configured, true)!.key);
    const settings = integrationSettingsFromEnv(configured);
    expect(settings.managedT3?.toolsDirectory).toBe('/opt/studio-native');
    expect(settings.localModel?.directory).toBe('/opt/studio-model');
    expect(() => integrationSettingsFromEnv({ ...configured,
      STUDIO_T3_MCP_URL: 'http://127.0.0.1:9999/mcp', STUDIO_T3_PROJECT: '/workspace/project',
    })).toThrow('free-model policy');
    expect(() => integrationSettingsFromEnv({ ...configured,
      STUDIO_SEARCH_URL: 'http://127.0.0.1:9999/search',
    })).toThrow('HTTPS');
  });
});
