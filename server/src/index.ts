import express from "express";
import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { loadConfig, type AppConfig } from "./config.js";
import { createYnabMcpServer } from "./mcp.js";
import { OAuthService } from "./oauth.js";
import { FirestoreStore, MemoryStore, type RecordStore } from "./store.js";

const DISCLAIMER = `We are not affiliated, associated, or in any way officially connected with YNAB or any of its subsidiaries or affiliates. The official YNAB website can be found at https://www.ynab.com. The names YNAB and You Need A Budget, as well as related names, tradenames, marks, trademarks, emblems, and images are registered trademarks of YNAB.`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character]!);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 20px;color:#17201b}h1,h2{line-height:1.2}footer{margin-top:48px;padding-top:20px;border-top:1px solid #ccd5ce;color:#4b5650;font-size:14px}</style></head><body>${body}<footer>${escapeHtml(DISCLAIMER)}</footer></body></html>`;
}

export function createApp(config: AppConfig, store: RecordStore, fetchImpl: typeof fetch = fetch) {
  const app = createMcpExpressApp({ host: "0.0.0.0", jsonLimit: "256kb" });
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));

  const oauth = new OAuthService(config, store, fetchImpl);
  app.use(oauth.router);
  app.use(mcpAuthMetadataRouter({
    oauthMetadata: oauth.metadata(),
    resourceServerUrl: config.mcpResourceUrl,
    serviceDocumentationUrl: config.publicBaseUrl,
    scopesSupported: ["ynab.read"],
    resourceName: "Financial Analysis for YNAB",
    dangerouslyAllowInsecureIssuerUrl: config.publicBaseUrl.protocol !== "https:",
  }));

  const auth = requireBearerAuth({
    verifier: oauth,
    requiredScopes: ["ynab.read"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpResourceUrl),
  });

  const mcpHandler = createMcpHandler((context) => {
    const grantId = context.authInfo?.extra?.grantId;
    if (typeof grantId !== "string") throw new Error("Authenticated request is missing its YNAB grant");
    return createYnabMcpServer(oauth, store, grantId, fetchImpl);
  }, { legacy: "stateless", responseMode: "json" });
  const handleMcp = toNodeHandler(mcpHandler);

  app.all("/mcp", auth, async (req, res) => {
    const grantId = req.auth?.extra?.grantId;
    if (typeof grantId !== "string") {
      res.status(401).json({ error: "invalid_token", error_description: "Token is missing its YNAB grant" });
      return;
    }
    try {
      await handleMcp(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: "server_error" });
    }
  });

  app.delete("/connection", auth, async (req, res) => {
    const grantId = req.auth?.extra?.grantId;
    if (typeof grantId !== "string") {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    await oauth.deleteGrant(grantId);
    res.status(204).end();
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/", (_req, res) => {
    res.type("html").send(page(
      "Financial Analysis for YNAB",
      "<h1>Financial Analysis for YNAB</h1><p>This private connector provides read-only YNAB data to an authorized MCP client for financial-health and major-purchase analysis.</p><p><a href=\"/privacy\">Privacy policy</a> · <a href=\"/delete\">Delete your connection</a></p>",
    ));
  });
  app.get("/privacy", (_req, res) => {
    res.type("html").send(page(
      "Privacy Policy — Financial Analysis for YNAB",
      `<h1>Privacy Policy</h1><p><strong>Last updated: August 28, 2026</strong></p>
      <h2>Purpose and data access</h2><p>This connector accesses YNAB plan data only after the user authorizes YNAB's read-only OAuth scope. It may retrieve plans, accounts, categories, targets, months, scheduled transactions, and transactions to answer the user's financial-analysis requests.</p>
      <h2>Storage and security</h2><p>YNAB access and refresh tokens are encrypted at rest. Connector access and refresh tokens are stored only as cryptographic hashes. To support transaction-change synchronization across service restarts, the connector also persists minimal synchronization metadata: the connector grant identifier, YNAB plan identifier, checkpoint name, YNAB server-knowledge cursor, and update timestamp. Checkpoint document identifiers are derived from a cryptographic hash of the authenticated grant, plan, and checkpoint name. The service does not persist YNAB plan, account, category, transaction, payee, or memo responses. Application logs must not contain tokens, authorization headers, transaction data, payees, or memos.</p>
      <h2>Sharing</h2><p>Requested YNAB data is returned to the user's authorized ChatGPT or MCP client so it can answer the user's request. Data is not sold and is not intentionally disclosed to anyone else. The client provider's own privacy and retention terms also apply to data it receives.</p>
      <h2>Retention and deletion</h2><p>OAuth grants, encrypted tokens, and transaction synchronization checkpoints remain until the user disconnects the connector, deletes the connection, or the authorization is revoked. Disconnecting deletes stored grant, token, and associated checkpoint records. Users can also revoke the application from YNAB Developer Settings.</p>
      <h2>Changes</h2><p>If the connector's data access or use changes materially, this policy will be updated and users will be asked to consent again before the changed access is used.</p>`,
    ));
  });
  app.get("/delete", (_req, res) => {
    res.type("html").send(page(
      "Delete connection — Financial Analysis for YNAB",
      "<h1>Delete your connection</h1><p>Disconnect this connector from ChatGPT to revoke its MCP session, then revoke the OAuth application in YNAB Developer Settings. An authenticated client can also send <code>DELETE /connection</code>, which immediately deletes the connector's stored grant, token, and transaction synchronization checkpoint records.</p>",
    ));
  });

  return app;
}

function createStore(config: AppConfig): RecordStore {
  return config.storeBackend === "memory" ? new MemoryStore() : new FirestoreStore(config.firestoreProjectId);
}

if (process.env.NODE_ENV !== "test") {
  const config = loadConfig();
  const app = createApp(config, createStore(config));
  app.listen(config.port, "0.0.0.0", () => {
    process.stderr.write(`Financial Analysis for YNAB listening on port ${config.port}\n`);
  });
}
