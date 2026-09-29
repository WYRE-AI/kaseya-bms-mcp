/**
 * Handler-invocation tests for the tool call dispatcher in src/index.ts.
 *
 * Replaces the "Tool Definitions" / "Credentials" / "Server Configuration"
 * blocks of test/index.test.ts, which asserted only against locally-declared
 * literal arrays/objects and never touched the real server (the issue #73
 * regression block in that file is real and now lives in
 * test/credentials.test.ts). Drives the real Server over a linked in-memory
 * transport (same pattern as test/mcp-apps.test.ts), mocking
 * @wyre-technology/node-kaseya-bms so each test asserts the exact outbound
 * call shape and response transformation -- for kaseya_bms_get_ticket, only a
 * minimal call-shape check lives here, since its full response/_card shape is
 * already covered by test/mcp-apps.test.ts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer, type KaseyaBmsCredentials } from "../src/index.js";
import { bindServerRef } from "../src/utils/server-ref.js";

const {
  mockTicketsList,
  mockTicketsGet,
  mockTicketsCreate,
  mockTicketsAddNote,
  mockTimeEntriesList,
  mockAccountsList,
  mockAccountsGet,
  mockContactsList,
  mockContractsList,
  mockCatalogList,
  mockKnowledgeBaseList,
} = vi.hoisted(() => ({
  mockTicketsList: vi.fn(),
  mockTicketsGet: vi.fn(),
  mockTicketsCreate: vi.fn(),
  mockTicketsAddNote: vi.fn(),
  mockTimeEntriesList: vi.fn(),
  mockAccountsList: vi.fn(),
  mockAccountsGet: vi.fn(),
  mockContactsList: vi.fn(),
  mockContractsList: vi.fn(),
  mockCatalogList: vi.fn(),
  mockKnowledgeBaseList: vi.fn(),
}));

vi.mock("@wyre-technology/node-kaseya-bms", () => ({
  KaseyaBmsClient: class {
    tickets = {
      list: mockTicketsList,
      get: mockTicketsGet,
      create: mockTicketsCreate,
      addNote: mockTicketsAddNote,
    };
    timeEntries = { list: mockTimeEntriesList };
    accounts = { list: mockAccountsList, get: mockAccountsGet };
    contacts = { list: mockContactsList };
    contracts = { list: mockContractsList };
    catalog = { list: mockCatalogList };
    knowledgeBase = { list: mockKnowledgeBaseList };
  },
}));

const ALL_MOCKS = [
  mockTicketsList,
  mockTicketsGet,
  mockTicketsCreate,
  mockTicketsAddNote,
  mockTimeEntriesList,
  mockAccountsList,
  mockAccountsGet,
  mockContactsList,
  mockContractsList,
  mockCatalogList,
  mockKnowledgeBaseList,
];

const CREDS: KaseyaBmsCredentials = { tenantSubdomain: "acme", apiToken: "test-token" };

async function connectClient(creds?: KaseyaBmsCredentials): Promise<Client> {
  // Bind the server ref exactly like the real stdio/HTTP entrypoints do, so
  // "elicitation unavailable" tests exercise the real reason it's
  // unavailable -- the connected client not declaring the capability --
  // rather than accidentally testing a ref that was never bound at all.
  const server = createMcpServer(creds);
  bindServerRef(server);
  const client = new Client({ name: "test-host", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type ElicitResponse = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

/**
 * A Client that declares elicitation support. `response` is either a single
 * fixed answer for every prompt, or a function keyed on the requested
 * field's name -- needed for a multi-step flow like resolveDateWindow's
 * custom-range branch, which asks two different questions ("startDate" then
 * "endDate") in sequence and needs a different answer for each.
 */
async function connectElicitingClient(
  creds: KaseyaBmsCredentials,
  response: ElicitResponse | ((fieldName: string) => ElicitResponse)
): Promise<Client> {
  const server = createMcpServer(creds);
  bindServerRef(server);
  const client = new Client(
    { name: "test-host", version: "0.0.0" },
    { capabilities: { elicitation: { form: {} } } }
  );
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    if (typeof response === "function") {
      const fieldName = Object.keys(request.params.requestedSchema.properties)[0];
      return response(fieldName);
    }
    return response;
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

function text(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const m of ALL_MOCKS) m.mockReset();
});

describe("tool surface", () => {
  it("exposes exactly the 10 documented tools", async () => {
    const client = await connectClient(CREDS);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "kaseya_bms_list_tickets",
        "kaseya_bms_get_ticket",
        "kaseya_bms_create_ticket",
        "kaseya_bms_add_ticket_note",
        "kaseya_bms_list_time_entries",
        "kaseya_bms_list_accounts",
        "kaseya_bms_list_contacts",
        "kaseya_bms_list_contracts",
        "kaseya_bms_list_service_catalog",
        "kaseya_bms_search_knowledge_base",
      ].sort()
    );
  });
});

describe("missing credentials", () => {
  it("returns an isError result instead of calling the API client", async () => {
    vi.stubEnv("KASEYA_BMS_TENANT_SUBDOMAIN", "");
    const client = await connectClient();
    const result = (await client.callTool({
      name: "kaseya_bms_list_tickets",
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/No API credentials provided/);
    expect(mockTicketsList).not.toHaveBeenCalled();
  });
});

describe("kaseya_bms_list_tickets", () => {
  it("defaults top to 100 with no filter/skip when elicitation is unavailable", async () => {
    mockTicketsList.mockResolvedValue([{ Id: 1 }]);
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_bms_list_tickets",
      arguments: {},
    })) as ToolResult;
    expect(mockTicketsList).toHaveBeenCalledWith({ top: 100, skip: undefined, filter: undefined });
    expect(JSON.parse(text(result))).toEqual([{ Id: 1 }]);
  });

  it("forwards an explicit filter without prompting", async () => {
    mockTicketsList.mockResolvedValue([]);
    const client = await connectClient(CREDS);
    await client.callTool({
      name: "kaseya_bms_list_tickets",
      arguments: { filter: "Status eq 'Open'", skip: 10 },
    });
    expect(mockTicketsList).toHaveBeenCalledWith({ top: 100, skip: 10, filter: "Status eq 'Open'" });
  });

  it("caps top at the 2000 hard cap", async () => {
    mockTicketsList.mockResolvedValue([]);
    const client = await connectClient(CREDS);
    await client.callTool({
      name: "kaseya_bms_list_tickets",
      arguments: { top: 50000 },
    });
    expect(mockTicketsList).toHaveBeenCalledWith({ top: 2000, skip: undefined, filter: undefined });
  });

  it("builds a Status filter from a preset choice when elicitation is available", async () => {
    mockTicketsList.mockResolvedValue([]);
    const client = await connectElicitingClient(CREDS, { action: "accept", content: { status: "Open" } });
    await client.callTool({ name: "kaseya_bms_list_tickets", arguments: {} });
    expect(mockTicketsList).toHaveBeenCalledWith({ top: 100, skip: undefined, filter: "Status eq 'Open'" });
  });

  it("returns no filter when the user picks 'all tickets'", async () => {
    mockTicketsList.mockResolvedValue([]);
    const client = await connectElicitingClient(CREDS, { action: "accept", content: { status: "__all__" } });
    await client.callTool({ name: "kaseya_bms_list_tickets", arguments: {} });
    expect(mockTicketsList).toHaveBeenCalledWith({ top: 100, skip: undefined, filter: undefined });
  });

  it("prompts for a custom OData filter and forwards it verbatim", async () => {
    mockTicketsList.mockResolvedValue([]);
    const client = await connectElicitingClient(CREDS, (fieldName) =>
      fieldName === "status"
        ? { action: "accept", content: { status: "__custom__" } }
        : { action: "accept", content: { filter: "Priority eq 'High'" } }
    );
    await client.callTool({ name: "kaseya_bms_list_tickets", arguments: {} });
    expect(mockTicketsList).toHaveBeenCalledWith({ top: 100, skip: undefined, filter: "Priority eq 'High'" });
  });

  it("returns no filter when the elicitation-level decline is sent", async () => {
    mockTicketsList.mockResolvedValue([]);
    const client = await connectElicitingClient(CREDS, { action: "decline" });
    await client.callTool({ name: "kaseya_bms_list_tickets", arguments: {} });
    expect(mockTicketsList).toHaveBeenCalledWith({ top: 100, skip: undefined, filter: undefined });
  });
});

describe("kaseya_bms_get_ticket", () => {
  it("calls tickets.get with the exact ticket id", async () => {
    mockTicketsGet.mockResolvedValue({ Id: 4821 });
    mockAccountsGet.mockResolvedValue({ Id: 77, Name: "Acme Corp" });
    const client = await connectClient(CREDS);
    await client.callTool({ name: "kaseya_bms_get_ticket", arguments: { ticketId: "4821" } });
    expect(mockTicketsGet).toHaveBeenCalledWith("4821");
  });
});

describe("kaseya_bms_create_ticket", () => {
  it("creates the ticket, mapping camelCase input to PascalCase fields, when the user confirms", async () => {
    mockTicketsCreate.mockResolvedValue({ Id: 99, Subject: "VPN down" });
    const client = await connectElicitingClient(CREDS, { action: "accept", content: { confirm: true } });
    const result = (await client.callTool({
      name: "kaseya_bms_create_ticket",
      arguments: {
        subject: "VPN down",
        description: "Office VPN is unreachable",
        accountId: "77",
        contactId: "12",
        priority: "High",
        status: "Open",
      },
    })) as ToolResult;
    expect(mockTicketsCreate).toHaveBeenCalledWith({
      Subject: "VPN down",
      Description: "Office VPN is unreachable",
      AccountId: "77",
      ContactId: "12",
      Priority: "High",
      Status: "Open",
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual({ Id: 99, Subject: "VPN down" });
  });

  it("cancels without calling the client when the user declines the confirm field", async () => {
    const client = await connectElicitingClient(CREDS, { action: "accept", content: { confirm: false } });
    const result = (await client.callTool({
      name: "kaseya_bms_create_ticket",
      arguments: { subject: "VPN down", description: "x" },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(text(result)).toBe("Ticket creation cancelled by user.");
    expect(mockTicketsCreate).not.toHaveBeenCalled();
  });

  it("cancels without calling the client when confirmation is unsupported", async () => {
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_bms_create_ticket",
      arguments: { subject: "VPN down", description: "x" },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(text(result)).toBe("Ticket creation cancelled by user.");
    expect(mockTicketsCreate).not.toHaveBeenCalled();
  });
});

describe("kaseya_bms_add_ticket_note", () => {
  it("appends the note when the user confirms", async () => {
    mockTicketsAddNote.mockResolvedValue({ ok: true });
    const client = await connectElicitingClient(CREDS, { action: "accept", content: { confirm: true } });
    const result = (await client.callTool({
      name: "kaseya_bms_add_ticket_note",
      arguments: { ticketId: "4821", body: "Called customer back", isInternal: true },
    })) as ToolResult;
    expect(mockTicketsAddNote).toHaveBeenCalledWith("4821", {
      Note: "Called customer back",
      IsInternal: true,
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual({ ok: true });
  });

  it("cancels without calling the client when the user sends an elicitation-level decline", async () => {
    const client = await connectElicitingClient(CREDS, { action: "decline" });
    const result = (await client.callTool({
      name: "kaseya_bms_add_ticket_note",
      arguments: { ticketId: "4821", body: "note" },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(text(result)).toBe("Note add cancelled by user.");
    expect(mockTicketsAddNote).not.toHaveBeenCalled();
  });
});

describe("kaseya_bms_list_time_entries", () => {
  it("passes through an explicit date range without prompting", async () => {
    mockTimeEntriesList.mockResolvedValue([{ id: "te1" }]);
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_bms_list_time_entries",
      arguments: { startDate: "2026-09-01", endDate: "2026-09-29" },
    })) as ToolResult;
    expect(mockTimeEntriesList).toHaveBeenCalledWith({
      startDate: "2026-09-01",
      endDate: "2026-09-29",
      top: 100,
    });
    expect(JSON.parse(text(result))).toEqual([{ id: "te1" }]);
  });

  it("resolves a preset window (7d) when no range is given and elicitation is available", async () => {
    mockTimeEntriesList.mockResolvedValue([]);
    const client = await connectElicitingClient(CREDS, { action: "accept", content: { window: "7d" } });
    await client.callTool({ name: "kaseya_bms_list_time_entries", arguments: {} });
    expect(mockTimeEntriesList).toHaveBeenCalledTimes(1);
    const call = mockTimeEntriesList.mock.calls[0][0] as { startDate?: string; endDate?: string; top: number };
    expect(call.top).toBe(100);
    expect(call.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(call.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("prompts for a custom start/end date and forwards both", async () => {
    mockTimeEntriesList.mockResolvedValue([]);
    const client = await connectElicitingClient(CREDS, (fieldName) => {
      if (fieldName === "window") return { action: "accept", content: { window: "__custom__" } };
      if (fieldName === "startDate") return { action: "accept", content: { startDate: "2026-01-01" } };
      return { action: "accept", content: { endDate: "2026-01-31" } };
    });
    await client.callTool({ name: "kaseya_bms_list_time_entries", arguments: {} });
    expect(mockTimeEntriesList).toHaveBeenCalledWith({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      top: 100,
    });
  });

  it("passes no date bounds when the user picks 'all time'", async () => {
    mockTimeEntriesList.mockResolvedValue([]);
    const client = await connectElicitingClient(CREDS, { action: "accept", content: { window: "__all__" } });
    await client.callTool({ name: "kaseya_bms_list_time_entries", arguments: {} });
    expect(mockTimeEntriesList).toHaveBeenCalledWith({ startDate: undefined, endDate: undefined, top: 100 });
  });
});

describe("kaseya_bms_list_accounts", () => {
  it("defaults top to 250 and caps at the hard cap", async () => {
    mockAccountsList.mockResolvedValue([{ Id: 77 }]);
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_bms_list_accounts",
      arguments: {},
    })) as ToolResult;
    expect(mockAccountsList).toHaveBeenCalledWith({ top: 250, filter: undefined });
    expect(JSON.parse(text(result))).toEqual([{ Id: 77 }]);

    mockAccountsList.mockClear();
    await client.callTool({ name: "kaseya_bms_list_accounts", arguments: { top: 999999 } });
    expect(mockAccountsList).toHaveBeenCalledWith({ top: 2000, filter: undefined });
  });
});

describe("kaseya_bms_list_contacts", () => {
  it("forwards an explicit filter", async () => {
    mockContactsList.mockResolvedValue([{ Id: 1 }]);
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_bms_list_contacts",
      arguments: { filter: "AccountId eq 77" },
    })) as ToolResult;
    expect(mockContactsList).toHaveBeenCalledWith({ top: 250, filter: "AccountId eq 77" });
    expect(JSON.parse(text(result))).toEqual([{ Id: 1 }]);
  });
});

describe("kaseya_bms_list_contracts", () => {
  it("defaults top to 250 with no filter", async () => {
    mockContractsList.mockResolvedValue([{ Id: 5 }]);
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_bms_list_contracts",
      arguments: {},
    })) as ToolResult;
    expect(mockContractsList).toHaveBeenCalledWith({ top: 250, filter: undefined });
    expect(JSON.parse(text(result))).toEqual([{ Id: 5 }]);
  });
});

describe("kaseya_bms_list_service_catalog", () => {
  it("defaults top to 250", async () => {
    mockCatalogList.mockResolvedValue([{ Id: "svc1" }]);
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_bms_list_service_catalog",
      arguments: {},
    })) as ToolResult;
    expect(mockCatalogList).toHaveBeenCalledWith({ top: 250 });
    expect(JSON.parse(text(result))).toEqual([{ Id: "svc1" }]);
  });
});

describe("kaseya_bms_search_knowledge_base", () => {
  it("builds a case-insensitive Title contains filter from an explicit query", async () => {
    mockKnowledgeBaseList.mockResolvedValue([{ Id: "kb1" }]);
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_bms_search_knowledge_base",
      arguments: { query: "VPN Setup" },
    })) as ToolResult;
    expect(mockKnowledgeBaseList).toHaveBeenCalledWith({
      top: 50,
      filter: "contains(tolower(Title), 'vpn setup')",
    });
    expect(JSON.parse(text(result))).toEqual([{ Id: "kb1" }]);
  });

  it("escapes a single quote in the query so it can't break the OData filter", async () => {
    mockKnowledgeBaseList.mockResolvedValue([]);
    const client = await connectClient(CREDS);
    await client.callTool({
      name: "kaseya_bms_search_knowledge_base",
      arguments: { query: "user's password" },
    });
    expect(mockKnowledgeBaseList).toHaveBeenCalledWith({
      top: 50,
      filter: "contains(tolower(Title), 'user''s password')",
    });
  });

  it("prompts for a query when none is provided and elicitation is available", async () => {
    mockKnowledgeBaseList.mockResolvedValue([]);
    const client = await connectElicitingClient(CREDS, { action: "accept", content: { query: "printer" } });
    await client.callTool({ name: "kaseya_bms_search_knowledge_base", arguments: {} });
    expect(mockKnowledgeBaseList).toHaveBeenCalledWith({
      top: 50,
      filter: "contains(tolower(Title), 'printer')",
    });
  });

  it("searches with no filter when no query is provided and elicitation is unavailable", async () => {
    mockKnowledgeBaseList.mockResolvedValue([]);
    const client = await connectClient(CREDS);
    await client.callTool({ name: "kaseya_bms_search_knowledge_base", arguments: {} });
    expect(mockKnowledgeBaseList).toHaveBeenCalledWith({ top: 50, filter: undefined });
  });
});

describe("tool error handling", () => {
  it("returns an isError result instead of throwing when the client rejects", async () => {
    mockAccountsList.mockRejectedValue(new Error("upstream 500"));
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_bms_list_accounts",
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Error: upstream 500");
  });
});

describe("unknown tool", () => {
  it("returns an isError result naming the unknown tool", async () => {
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "kaseya_bms_not_a_real_tool",
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Unknown tool: kaseya_bms_not_a_real_tool");
  });
});
