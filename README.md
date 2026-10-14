# Kaseya BMS MCP Server

[![Release](https://github.com/WYRE-AI/kaseya-bms-mcp/actions/workflows/release.yml/badge.svg)](https://github.com/WYRE-AI/kaseya-bms-mcp/actions/workflows/release.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Model Context Protocol (MCP) server for the Kaseya BMS PSA API.
Exposes tickets, accounts, contacts, contracts, time entries, the service
catalog, and the knowledge base to AI assistants.

## Tools

| Tool | Description |
|------|-------------|
| `kaseya_bms_list_tickets` | List tickets. Optional `$filter`; status pick if omitted. |
| `kaseya_bms_get_ticket` | Get a ticket by id. |
| `kaseya_bms_create_ticket` | Create a new ticket (destructive — confirmation required). |
| `kaseya_bms_add_ticket_note` | Append a note to a ticket (destructive — confirmation required). |
| `kaseya_bms_list_time_entries` | Time entries by date range (24h / 7d / 30d / custom / all). |
| `kaseya_bms_list_accounts` | Accounts (clients). |
| `kaseya_bms_list_contacts` | Contacts. |
| `kaseya_bms_list_contracts` | Contracts. |
| `kaseya_bms_list_service_catalog` | Service catalog items. |
| `kaseya_bms_search_knowledge_base` | Knowledge base search. |

When the user omits required filters or runs a destructive action, the server
uses MCP elicitation to prompt for choices or confirm.

## Interactive Ticket Card (MCP Apps)

`kaseya_bms_get_ticket` renders as an interactive card in MCP Apps hosts
(Claude Desktop/web) with an in-card "Add note" round-trip via
`kaseya_bms_add_ticket_note` (always posted internal-only); plain-JSON
behavior is unchanged in other hosts. The card is neutral by default and
brandable via `window.__BRAND__` injection or `MCP_BRAND_*` env vars
(`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`, `MCP_BRAND_PRIMARY_COLOR`,
`MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`, `MCP_BRAND_TEXT`) — no rebuild
needed. After editing `ui/`, regenerate the embedded bundle with
`npm run build:ui`.

## Configuration

Copy [`.env.example`](.env.example). Stdio and `AUTH_MODE=env` read the Kaseya BMS variables. Gateway mode does not.

| Variable | Required | Description |
|----------|----------|-------------|
| `KASEYA_BMS_TENANT_SUBDOMAIN` | For stdio and `AUTH_MODE=env` | Tenant subdomain (e.g. `yourcompany`) |
| `KASEYA_BMS_API_TOKEN` | One of, for stdio and `AUTH_MODE=env` | BMS API token |
| `KASEYA_BMS_K1_TOKEN` | One of, for stdio and `AUTH_MODE=env` | Kaseya One SSO token |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http` |
| `AUTH_MODE` | No | `env` (default) or `gateway`. Gateway mode requires `X-Kaseya-BMS-Tenant-Subdomain` plus `X-Kaseya-BMS-API-Token` or `X-Kaseya-BMS-K1-Token` on each `/mcp` request and never falls back to `KASEYA_BMS_*`. |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret. The HTTP server logs an error and exits non-zero when this is empty or a known placeholder. Compose will not start without it. Never commit a real value. Generate one with `openssl rand -hex 32`. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning, does not enforce `X-Gateway-S2S`, and binds `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` refuses startup. A known placeholder secret is still refused. |
| `MCP_HTTP_HOST` | No | Bind address when a real `CONDUIT_S2S_SECRET` is set. Unset keeps `0.0.0.0`, which is what the container image sets, so container deploys stay on every interface inside the container. Without a secret the dev bypass binds `127.0.0.1` instead. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |

`/health` stays unauthenticated and does not read credentials. The stdio transport does not use `CONDUIT_S2S_SECRET`.

### HTTP authentication

With `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` set, every `/mcp` request must include `X-Gateway-S2S`. The value is `t=<unix seconds>,v1=<hex>`, where `v1` is HMAC-SHA256 of the exact string `t=<unix seconds>` keyed by `CONDUIT_S2S_SECRET` (64 lowercase hex characters). The timestamp must be within 300 seconds of the server clock. A missing or invalid header returns 401. The secret is never written to logs.

```js
import { createHmac } from "node:crypto";

const t = Math.floor(Date.now() / 1000);
const v1 = createHmac("sha256", process.env.CONDUIT_S2S_SECRET)
  .update(`t=${t}`)
  .digest("hex");
const xGatewayS2s = `t=${t},v1=${v1}`;
```

In `AUTH_MODE=gateway`, `/mcp` also requires `X-Kaseya-BMS-Tenant-Subdomain` and either `X-Kaseya-BMS-API-Token` or `X-Kaseya-BMS-K1-Token`. Those headers are the only credential source for that request. A request missing them returns 401 and does not read `KASEYA_BMS_*` from the environment. Each request creates a fresh server instance with isolated credentials.

### Docker Compose

The checked-in Compose service is gateway mode. It publishes `127.0.0.1:8080:8080`, requires `CONDUIT_S2S_SECRET`, and does not set `KASEYA_BMS_TENANT_SUBDOMAIN`, `KASEYA_BMS_API_TOKEN`, `KASEYA_BMS_K1_TOKEN`, or `env_file`. The image build reads GitHub Packages credentials from the `npmrc` build secret (the repo `.npmrc` only sets the registry).

```bash
CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" docker compose up --build
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses `KASEYA_BMS_*`:

```bash
docker build -t kaseya-bms-mcp .
docker run --rm \
  -e CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" \
  -e AUTH_MODE=env \
  -e KASEYA_BMS_TENANT_SUBDOMAIN=yourcompany \
  -e KASEYA_BMS_API_TOKEN=... \
  -p 127.0.0.1:8080:8080 \
  kaseya-bms-mcp
```

## Local development

```bash
npm install
npm run build
KASEYA_BMS_TENANT_SUBDOMAIN=yourcompany \
  KASEYA_BMS_API_TOKEN=... \
  npm start
```

HTTP refuses to start until `CONDUIT_S2S_SECRET` is a real secret:

```bash
MCP_TRANSPORT=http CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" npm start
curl http://127.0.0.1:8080/health
```

Local HTTP without a secret is development-only. It binds `127.0.0.1` and logs a warning:

```bash
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 npm start
```

## License

Apache-2.0
