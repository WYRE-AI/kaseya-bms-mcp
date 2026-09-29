import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Capture the options passed to the Kaseya BMS client constructor so we can
// prove which auth mode createClient() selects, without a real network client.
const { KaseyaBmsClientMock } = vi.hoisted(() => ({ KaseyaBmsClientMock: vi.fn() }));
vi.mock('@wyre-technology/node-kaseya-bms', () => ({ KaseyaBmsClient: KaseyaBmsClientMock }));

import { cleanCredential, getCredentials, createClient } from '../src/index.js';

// Regression tests for issue #73 (mirrors itglue-mcp #73). Both KASEYA_BMS_API_TOKEN
// and KASEYA_BMS_K1_TOKEN are optional and map to ${user_config.*} in manifest.json.
// When the Kaseya One token field is left blank, Claude Desktop injects the literal
// string "${user_config.kaseya_bms_k1_token}". Because createClient prefers the K1
// token over the API token, that placeholder was sent as the SSO token and a valid
// API token was ignored → auth failure. Credentials must be sanitised at ingress.
describe('issue #73: unresolved MCPB config placeholders', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('cleanCredential drops empty, whitespace, and ${...} placeholder values', () => {
    expect(cleanCredential(undefined)).toBeUndefined();
    expect(cleanCredential('')).toBeUndefined();
    expect(cleanCredential('   ')).toBeUndefined();
    expect(cleanCredential('${user_config.kaseya_bms_k1_token}')).toBeUndefined();
    expect(cleanCredential('  ${user_config.kaseya_bms_api_token}  ')).toBeUndefined();
  });

  it('cleanCredential preserves and trims real credentials', () => {
    expect(cleanCredential('real-api-token')).toBe('real-api-token');
    expect(cleanCredential('  real-api-token  ')).toBe('real-api-token');
  });

  it('getCredentials ignores a placeholder K1 token but keeps the API token', () => {
    process.env.KASEYA_BMS_TENANT_SUBDOMAIN = 'acme';
    process.env.KASEYA_BMS_API_TOKEN = 'real-api-token';
    process.env.KASEYA_BMS_K1_TOKEN = '${user_config.kaseya_bms_k1_token}';

    const creds = getCredentials();

    expect(creds).not.toBeNull();
    expect(creds?.apiToken).toBe('real-api-token');
    expect(creds?.kaseyaOneToken).toBeUndefined();
  });

  it('authenticates with the API token, not the bogus K1 placeholder (the auth-failure repro)', () => {
    process.env.KASEYA_BMS_TENANT_SUBDOMAIN = 'acme';
    process.env.KASEYA_BMS_API_TOKEN = 'real-api-token';
    process.env.KASEYA_BMS_K1_TOKEN = '${user_config.kaseya_bms_k1_token}';

    const creds = getCredentials();
    expect(creds).not.toBeNull();
    createClient(creds!);

    expect(KaseyaBmsClientMock).toHaveBeenCalledTimes(1);
    const opts = KaseyaBmsClientMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.apiToken).toBe('real-api-token');
    expect(opts.kaseyaOneToken).toBeUndefined();
  });
});
