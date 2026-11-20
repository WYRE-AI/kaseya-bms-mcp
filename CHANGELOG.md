# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Interactive ticket card via MCP Apps (SEP-1865).** `kaseya_bms_get_ticket`
  results now render as an interactive card in MCP Apps hosts (Claude
  Desktop/web, and other hosts advertising the `io.modelcontextprotocol/ui`
  extension), instead of a wall of JSON. The card shows status, priority,
  account, assignee, key dates, and the ticket description — and includes a
  working "Add note" round-trip that calls `kaseya_bms_add_ticket_note` from
  inside the card. Non-App hosts are unaffected: the tool's JSON payload is
  unchanged apart from a new `_card` field.
  - The two renderable tools advertise the UI via `_meta` (`ui/resourceUri`,
    plus the nested `ui.resourceUri` form) pointing at a new
    `ui://kaseya-bms/ticket-card.html` resource served as
    `text/html;profile=mcp-app`. The card HTML is a self-contained vite
    single-file bundle embedded at build time
    (`src/generated/ticket-card-html.ts`, committed), so it serves identically
    from stdio and Node HTTP without touching the filesystem. The server now
    declares the `resources` capability and answers `resources/list` /
    `resources/read`.
  - The card is neutral by default (system fonts, no vendor identity, no
    external fetches) and brandable via `window.__BRAND__` injection or
    `MCP_BRAND_*` env vars (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`,
    `MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`,
    `MCP_BRAND_TEXT`): at serve time the server replaces the card's
    BRAND_INJECT marker with an inline, `<`-escaped `window.__BRAND__` script,
    so self-hosters can theme the card without rebuilding. No brand configured
    = HTML served unchanged.
  - The card's "Add note" round-trip always posts with `IsInternal: true` —
    BMS note visibility is a universal boolean (not a tenant-specific enum),
    so an internal-only default is safe everywhere and the card never guesses
    visibility itself (`src/card.builder.ts`). The existing elicitation
    confirmation on `kaseya_bms_add_ticket_note` still applies, and the card
    treats a declined confirmation as "note not added".
  - The card payload builder is best-effort: a failed account lookup degrades
    the card (or drops it) without affecting the tool result. 20 new contract
    tests in `test/mcp-apps.test.ts` pin the `_meta` advertisement, the
    `ui://` resource wire shape, the neutral-default/brand-injection behavior,
    and the card normalization.
  - New `npm run build:ui` regenerates the embedded HTML after editing `ui/`
    (requires the new `vite`, `vite-plugin-singlefile`, and
    `@modelcontextprotocol/ext-apps` devDependencies); plain `npm run build`
    and CI are unaffected.

### Fixed
- **The HTTP transport no longer exits on a malformed request (WYREAI-741).** The request
  target was parsed against the client-supplied `Host` header, and a value that does not parse
  (or a target such as `//`) threw inside the request listener before authentication. The
  target is now parsed against a fixed base, so `Host` is no longer consulted, and a target
  that still cannot be parsed gets a `400` JSON response while the server keeps running.

- Ignore unresolved MCPB/DXT config placeholders (`${user_config.X}`) in
  credentials. When the optional Kaseya One token field was left blank, desktop
  hosts injected the literal `${user_config.kaseya_bms_k1_token}` string; because
  the client prefers the K1 token over the API token, that placeholder was sent
  as the SSO token and a valid API token was ignored, causing auth failures.
  Credentials are now sanitised at ingress (env and gateway header paths).
  Mirrors itglue-mcp #73.

### Added
- Initial scaffold of the Kaseya BMS MCP server.
- 10 tools: list/get/create tickets, add ticket notes, list time entries,
  accounts, contacts, contracts, service catalog, and KB search.
- stdio + HTTP transports with `env` and `gateway` auth modes.
- Stateless per-request server in HTTP mode for safe multi-tenant gateway use.
- Elicitation for destructive actions and missing date / status filters.
- CI, semantic-release, multi-stage Docker, MCPB packaging, and MCP Registry
  publishing workflows.
