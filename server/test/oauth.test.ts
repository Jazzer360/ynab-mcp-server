import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { developmentConfig } from "../src/config.js";
import { pkceChallenge, randomToken } from "../src/crypto.js";
import { createApp } from "../src/index.js";
import { MemoryStore } from "../src/store.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function mcpPayload(response: request.Response): Record<string, any> {
  if (response.body && Object.keys(response.body).length > 0) return response.body as Record<string, any>;
  const dataLine = response.text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`MCP response did not contain JSON-RPC data: ${response.text}`);
  return JSON.parse(dataLine.slice(6)) as Record<string, any>;
}

function mcpToolData(response: request.Response): Record<string, any> {
  const result = mcpPayload(response).result as Record<string, any>;
  if (result.structuredContent) return result.structuredContent as Record<string, any>;
  return JSON.parse(result.content[0].text) as Record<string, any>;
}

describe("browser OAuth bridge", () => {
  it("persists transaction-change checkpoints across app recreation without advancing truncated deltas", async () => {
    const config = developmentConfig();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: "ynab-access", refresh_token: "ynab-refresh", expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ data: { user: { id: "ynab-user-1" } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { transactions: [], server_knowledge: 10 } }))
      .mockResolvedValueOnce(jsonResponse({ data: {
        transactions: [{
          id: "changed-transaction",
          date: "2026-08-18",
          amount_currency: -16.35,
          account_name: "Card",
          category_name: "Shopping",
          cleared: "uncleared",
          approved: false,
          deleted: false,
        }],
        server_knowledge: 12,
      } }))
      .mockResolvedValueOnce(jsonResponse({ data: {
        transactions: [
          { id: "change-13", date: "2026-08-19", amount_currency: -3, deleted: false },
          { id: "change-14", date: "2026-08-20", amount_currency: -4, deleted: false },
        ],
        server_knowledge: 15,
      } }))
      .mockResolvedValueOnce(jsonResponse({ data: {
        transactions: [
          { id: "change-13", date: "2026-08-19", amount_currency: -3, deleted: false },
          { id: "change-14", date: "2026-08-20", amount_currency: -4, deleted: false },
        ],
        server_knowledge: 15,
      } }));
    const store = new MemoryStore();
    let app = createApp(config, store, fetchMock);
    const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";

    const registration = await request(app).post("/register").send({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(registration.status).toBe(201);
    const clientId = registration.body.client_id as string;

    const verifier = randomToken(48);
    const authorization = await request(app).get("/authorize").query({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      state: "chatgpt-state",
      scope: "ynab.read",
      resource: config.mcpResourceUrl.toString(),
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
    });
    expect(authorization.status).toBe(302);
    const ynabAuthorization = new URL(authorization.headers.location!);
    expect(ynabAuthorization.origin).toBe("https://app.ynab.com");
    expect(ynabAuthorization.searchParams.get("scope")).toBe("read-only");
    expect(ynabAuthorization.searchParams.get("code_challenge_method")).toBe("S256");

    const callback = await request(app).get("/oauth/ynab/callback").query({
      state: ynabAuthorization.searchParams.get("state"),
      code: "ynab-authorization-code",
    });
    expect(callback.status).toBe(302);
    const chatgptCallback = new URL(callback.headers.location!);
    expect(chatgptCallback.origin).toBe("https://chatgpt.com");
    expect(chatgptCallback.searchParams.get("state")).toBe("chatgpt-state");

    const token = await request(app).post("/token").type("form").send({
      grant_type: "authorization_code",
      client_id: clientId,
      code: chatgptCallback.searchParams.get("code"),
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    expect(token.status).toBe(200);
    expect(token.body.scope).toBe("ynab.read");
    expect(token.body.access_token).toEqual(expect.any(String));
    expect(token.body.refresh_token).toEqual(expect.any(String));

    const initialize = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token.body.access_token}`)
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
    });
    expect(initialize.status).toBe(200);
    expect(mcpPayload(initialize).result.serverInfo.name).toBe("financial-analysis-for-ynab");

    const tools = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token.body.access_token}`)
      .set("Accept", "application/json, text/event-stream")
      .set("MCP-Protocol-Version", "2025-06-18")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(tools.status).toBe(200);
    const listedTools = mcpPayload(tools).result.tools as Array<{
      name: string;
      title?: string;
      description?: string;
      annotations?: { readOnlyHint?: boolean };
    }>;
    expect(listedTools).toHaveLength(9);
    expect(listedTools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
    expect(listedTools[0]).toMatchObject({
      name: "get_transaction_changes",
      title: expect.stringContaining("persistent checkpoint"),
    });
    expect(listedTools[0]?.description).toContain("recent transactions");
    expect(listedTools[0]?.description).toContain("transaction changes");
    expect(listedTools[0]?.description).toContain("since last check");
    expect(listedTools[0]?.description).toContain("delta");
    expect(listedTools[0]?.description).toContain("persistent checkpoint");

    const planId = "11111111-1111-4111-8111-111111111111";
    const baseline = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token.body.access_token}`)
      .set("Accept", "application/json, text/event-stream")
      .set("MCP-Protocol-Version", "2025-06-18")
      .send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "get_transaction_changes",
          arguments: { plan_id: planId, checkpoint_name: "daily-spending-coach" },
        },
      });
    expect(baseline.status).toBe(200);
    expect(mcpToolData(baseline)).toMatchObject({
      checkpoint_name: "daily-spending-coach",
      checkpoint_advanced: true,
      initialized: true,
      server_knowledge: 10,
      changed_count: 0,
    });

    // Simulate a Cloud Run lifecycle restart by creating a new Express/MCP app
    // while retaining the same durable-style store backing the connector.
    app = createApp(config, store, fetchMock);

    const changes = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token.body.access_token}`)
      .set("Accept", "application/json, text/event-stream")
      .set("MCP-Protocol-Version", "2025-06-18")
      .send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "get_transaction_changes",
          arguments: { plan_id: planId, checkpoint_name: "daily-spending-coach" },
        },
      });
    expect(changes.status).toBe(200);
    expect(mcpToolData(changes)).toMatchObject({
      checkpoint_advanced: true,
      initialized: false,
      previous_server_knowledge: 10,
      server_knowledge: 12,
      changed_count: 1,
      transactions: [expect.objectContaining({ id: "changed-transaction", date: "2026-08-18" })],
    });
    expect(fetchMock.mock.calls[3]?.[0].toString()).toContain("last_knowledge_of_server=10");

    const truncated = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token.body.access_token}`)
      .set("Accept", "application/json, text/event-stream")
      .set("MCP-Protocol-Version", "2025-06-18")
      .send({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "get_transaction_changes",
          arguments: { plan_id: planId, checkpoint_name: "daily-spending-coach", limit: 1 },
        },
      });
    expect(truncated.status).toBe(200);
    expect(mcpToolData(truncated)).toMatchObject({
      checkpoint_advanced: false,
      previous_server_knowledge: 12,
      server_knowledge: 15,
      changed_count: 2,
      returned_count: 1,
      truncated: true,
    });

    const retry = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token.body.access_token}`)
      .set("Accept", "application/json, text/event-stream")
      .set("MCP-Protocol-Version", "2025-06-18")
      .send({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "get_transaction_changes",
          arguments: { plan_id: planId, checkpoint_name: "daily-spending-coach", limit: 500 },
        },
      });
    expect(retry.status).toBe(200);
    expect(mcpToolData(retry)).toMatchObject({
      checkpoint_advanced: true,
      previous_server_knowledge: 12,
      server_knowledge: 15,
      changed_count: 2,
      returned_count: 2,
      truncated: false,
    });
    expect(fetchMock.mock.calls[4]?.[0].toString()).toContain("last_knowledge_of_server=12");
    expect(fetchMock.mock.calls[5]?.[0].toString()).toContain("last_knowledge_of_server=12");

    const metadata = await request(app).get("/.well-known/oauth-protected-resource/mcp");
    expect(metadata.status).toBe(200);
    expect(metadata.body.authorization_servers).toContain(config.publicBaseUrl.toString());

    const deletion = await request(app)
      .delete("/connection")
      .set("Authorization", `Bearer ${token.body.access_token}`);
    expect(deletion.status).toBe(204);
  }, 15_000);

  it("rejects dynamic clients outside the configured redirect origins", async () => {
    const app = createApp(developmentConfig(), new MemoryStore(), vi.fn<typeof fetch>());
    const response = await request(app).post("/register").send({
      redirect_uris: ["https://evil.example/callback"],
      token_endpoint_auth_method: "none",
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_redirect_uri");
  });

  it("advertises authorization discovery when MCP access is unauthenticated", async () => {
    const app = createApp(developmentConfig(), new MemoryStore(), vi.fn<typeof fetch>());
    const response = await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("resource_metadata");
  });
});
