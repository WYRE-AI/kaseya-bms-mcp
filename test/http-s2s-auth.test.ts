/**
 * HTTP transport fail-closed auth (CWE-306).
 *
 * Startup requires a real CONDUIT_S2S_SECRET unless MCP_ALLOW_INSECURE_DEV=1.
 * A known placeholder always refuses to start. /mcp rejects a missing or
 * invalid X-Gateway-S2S header. AUTH_MODE=gateway rejects requests that omit
 * vendor credential headers and must not fall back to KASEYA_BMS_* in process.env.
 */

import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientCtor = vi.hoisted(() => vi.fn());
const accountsList = vi.hoisted(() => vi.fn(async () => [{ id: "acct-1" }]));

vi.mock("@wyre-technology/node-kaseya-bms", () => ({
  KaseyaBmsClient: class {
    constructor(opts: unknown) {
      clientCtor(opts);
    }
    accounts = { list: accountsList };
  },
}));

import { KNOWN_PLACEHOLDER_SECRETS, startHttpTransport } from "../src/index.js";

const S2S_SECRET = "test-s2s-fail-closed-secret-do-not-use-in-prod";
const ENV_TENANT = "env-tenant-must-not-be-used";
const ENV_API_TOKEN = "env-api-token-must-not-be-used";
const ENV_K1_TOKEN = "env-k1-token-must-not-be-used";
const HEADER_TENANT = "header-tenant";
const HEADER_API_TOKEN = "header-api-token";

const PLACEHOLDER_MESSAGE =
  "Refusing to start HTTP server: CONDUIT_S2S_SECRET is a known placeholder. " +
  "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.";

const ENV_KEYS = [
  "CONDUIT_S2S_SECRET",
  "MCP_ALLOW_INSECURE_DEV",
  "MCP_HTTP_PORT",
  "MCP_HTTP_HOST",
  "AUTH_MODE",
  "KASEYA_BMS_TENANT_SUBDOMAIN",
  "KASEYA_BMS_API_TOKEN",
  "KASEYA_BMS_K1_TOKEN",
  "MCP_TRANSPORT",
] as const;

const savedEnv = new Map<string, string | undefined>();
const servers: Server[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `${message},v1=${hex}`;
}

function silenceLogs(): { errors: string[] } {
  const errors: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  });
  return { errors };
}

function assertNoSecrets(logged: string): void {
  expect(logged).not.toContain(S2S_SECRET);
  expect(logged).not.toContain(ENV_TENANT);
  expect(logged).not.toContain(ENV_API_TOKEN);
  expect(logged).not.toContain(ENV_K1_TOKEN);
  expect(logged).not.toContain(HEADER_API_TOKEN);
}

function refuseExit(): void {
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

async function listen(): Promise<{ server: Server; port: number; address: string }> {
  const server = await startHttpTransport();
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === "string") {
    throw new Error("HTTP server did not bind a TCP port");
  }
  return { server, port: bound.port, address: bound.address };
}

function mcpHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extra,
  };
}

const listCall = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "kaseya_bms_list_accounts", arguments: {} },
};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.MCP_HTTP_PORT = "0";
  process.env.KASEYA_BMS_TENANT_SUBDOMAIN = ENV_TENANT;
  process.env.KASEYA_BMS_API_TOKEN = ENV_API_TOKEN;
  process.env.KASEYA_BMS_K1_TOKEN = ENV_K1_TOKEN;
  clientCtor.mockReset();
  accountsList.mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server?.listening) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("HTTP startup fails closed", () => {
  it("refuses to start when CONDUIT_S2S_SECRET is unset", async () => {
    const { errors } = silenceLogs();
    refuseExit();

    await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
    const logged = errors.join("\n");
    expect(logged).toContain("Refusing to start HTTP server: CONDUIT_S2S_SECRET is empty.");
    expect(logged).toContain("MCP_ALLOW_INSECURE_DEV=1");
    assertNoSecrets(logged);
  });

  it("still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "true";
    const { errors } = silenceLogs();
    refuseExit();

    await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
    expect(errors.join("\n")).toContain("CONDUIT_S2S_SECRET is empty");
  });

  it("treats a whitespace-only secret as empty", async () => {
    process.env.CONDUIT_S2S_SECRET = "   ";
    silenceLogs();
    refuseExit();
    await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
  });

  it.each([...KNOWN_PLACEHOLDER_SECRETS])(
    "refuses known placeholder %s and does not log it",
    async (placeholder) => {
      process.env.CONDUIT_S2S_SECRET = placeholder;
      const { errors } = silenceLogs();
      refuseExit();

      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      const logged = errors.join("\n");
      expect(logged).toContain(PLACEHOLDER_MESSAGE);
      expect(logged.replace(PLACEHOLDER_MESSAGE, "")).not.toContain(placeholder);
      assertNoSecrets(logged);
    }
  );

  it("refuses a placeholder even when MCP_ALLOW_INSECURE_DEV=1 and does not log it", async () => {
    process.env.CONDUIT_S2S_SECRET = "  Your-S2S-Secret  ";
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    const { errors } = silenceLogs();
    refuseExit();

    await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
    const logged = errors.join("\n");
    expect(logged).toContain("known placeholder");
    expect(logged).not.toContain("Your-S2S-Secret");
    expect(logged).not.toContain("your-s2s-secret");
  });

  it("refuses an unresolved ${...} template even when the dev bypass is set", async () => {
    process.env.CONDUIT_S2S_SECRET = "${user_config.conduit_s2s_secret}";
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    const { errors } = silenceLogs();
    refuseExit();

    await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
    const logged = errors.join("\n");
    expect(logged).toContain("known placeholder");
    expect(logged).not.toContain("user_config.conduit_s2s_secret");
  });

  it("starts on 127.0.0.1 with a warning when MCP_ALLOW_INSECURE_DEV=1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    const { errors } = silenceLogs();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${String(code)}`);
    }) as typeof process.exit);

    const { address } = await listen();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(address).toBe("127.0.0.1");
    const logged = errors.join("\n");
    expect(logged).toContain("SECURITY WARNING");
    expect(logged).toContain("MCP_ALLOW_INSECURE_DEV=1");
    expect(logged).toContain("DISABLED");
    expect(logged).toContain("127.0.0.1");
    assertNoSecrets(logged);
  });

  it("forces 127.0.0.1 and logs when the dev bypass host is another loopback name", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = "localhost";
    const { errors } = silenceLogs();

    const { address } = await listen();
    expect(address).toBe("127.0.0.1");
    const logged = errors.join("\n");
    expect(logged).toContain("MCP_HTTP_HOST=localhost");
    expect(logged).toContain("binds 127.0.0.1 only");
    assertNoSecrets(logged);
  });

  it("refuses the dev bypass when MCP_HTTP_HOST is not loopback", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const { errors } = silenceLogs();
    refuseExit();

    await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
    const logged = errors.join("\n");
    expect(logged).toContain("MCP_HTTP_HOST=0.0.0.0 is not loopback");
    expect(logged).toContain("only binds 127.0.0.1");
    assertNoSecrets(logged);
  });

  it("honors MCP_HTTP_HOST=0.0.0.0 when a real secret is set", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const { errors } = silenceLogs();

    const { address } = await listen();
    expect(address).toBe("0.0.0.0");
    expect(errors.join("\n")).not.toContain("not loopback");
    assertNoSecrets(errors.join("\n"));
  });

  it("keeps the 0.0.0.0 default when a real secret is set and MCP_HTTP_HOST is unset", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    const { errors } = silenceLogs();

    const { address } = await listen();
    expect(address).toBe("0.0.0.0");
    assertNoSecrets(errors.join("\n"));
  });
});

describe("HTTP /mcp authentication", () => {
  async function postMcp(port: number, headers: Record<string, string>): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: mcpHeaders(headers),
      body: JSON.stringify(listCall),
    });
  }

  it("returns 401 when the S2S header is missing or invalid and does not read credentials", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "gateway";
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    const { errors } = silenceLogs();
    const { port } = await listen();
    assertNoSecrets(errors.join("\n"));

    const credentialHeaders = {
      "x-kaseya-bms-tenant-subdomain": HEADER_TENANT,
      "x-kaseya-bms-api-token": HEADER_API_TOKEN,
    };

    const missing = await postMcp(port, credentialHeaders);
    expect(missing.status).toBe(401);
    const missingBody = (await missing.json()) as { error: string };
    expect(missingBody.error).toContain("X-Gateway-S2S");
    expect(JSON.stringify(missingBody)).not.toContain(ENV_API_TOKEN);
    expect(JSON.stringify(missingBody)).not.toContain(S2S_SECRET);
    expect(JSON.stringify(missingBody)).not.toContain(HEADER_API_TOKEN);

    const invalid = await postMcp(port, {
      ...credentialHeaders,
      "x-gateway-s2s": mintS2sHeader("wrong-secret"),
    });
    expect(invalid.status).toBe(401);
    const invalidBody = (await invalid.json()) as { error: string };
    expect(invalidBody.error).toContain("X-Gateway-S2S");
    expect(clientCtor).not.toHaveBeenCalled();
  });

  it("returns 401 in gateway mode without credential headers and does not use env credentials", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "gateway";
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    silenceLogs();
    const { port } = await listen();

    const response = await postMcp(port, { "x-gateway-s2s": mintS2sHeader(S2S_SECRET) });
    const body = (await response.json()) as { error: string; required: string[] };

    expect(response.status).toBe(401);
    expect(body.error).toBe("Missing credentials");
    expect(body.required).toEqual([
      "X-Kaseya-BMS-Tenant-Subdomain",
      "X-Kaseya-BMS-API-Token OR X-Kaseya-BMS-K1-Token",
    ]);
    expect(JSON.stringify(body)).not.toContain(ENV_TENANT);
    expect(JSON.stringify(body)).not.toContain(ENV_API_TOKEN);
    expect(JSON.stringify(body)).not.toContain(ENV_K1_TOKEN);
    expect(JSON.stringify(body)).not.toContain(S2S_SECRET);
    expect(clientCtor).not.toHaveBeenCalled();

    const partial = await postMcp(port, {
      "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
      "x-kaseya-bms-tenant-subdomain": HEADER_TENANT,
    });
    expect(partial.status).toBe(401);
    expect(clientCtor).not.toHaveBeenCalled();
  });

  it("returns 401 in gateway mode when the only token is an unresolved placeholder", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "gateway";
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    silenceLogs();
    const { port } = await listen();

    const response = await postMcp(port, {
      "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
      "x-kaseya-bms-tenant-subdomain": HEADER_TENANT,
      "x-kaseya-bms-api-token": "${user_config.kaseya_bms_api_token}",
    });
    expect(response.status).toBe(401);
    expect(clientCtor).not.toHaveBeenCalled();
  });

  it("accepts a valid S2S header plus credential headers and uses those credentials", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "gateway";
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    silenceLogs();
    const { port } = await listen();

    const response = await postMcp(port, {
      "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
      "x-kaseya-bms-tenant-subdomain": HEADER_TENANT,
      "x-kaseya-bms-api-token": HEADER_API_TOKEN,
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain(ENV_TENANT);
    expect(JSON.stringify(body)).not.toContain(ENV_API_TOKEN);
    expect(JSON.stringify(body)).not.toContain(ENV_K1_TOKEN);
    expect(JSON.stringify(body)).not.toContain(S2S_SECRET);
    expect(clientCtor).toHaveBeenCalledWith({
      tenantSubdomain: HEADER_TENANT,
      apiToken: HEADER_API_TOKEN,
    });
  });

  it("serves /health without authentication and without reading credentials", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "gateway";
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    silenceLogs();
    const { port } = await listen();

    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const body = (await response.json()) as { status: string; authMode: string };

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.authMode).toBe("gateway");
    expect(JSON.stringify(body)).not.toContain(ENV_TENANT);
    expect(JSON.stringify(body)).not.toContain(ENV_API_TOKEN);
    expect(JSON.stringify(body)).not.toContain(S2S_SECRET);
    expect(clientCtor).not.toHaveBeenCalled();
  });
});
