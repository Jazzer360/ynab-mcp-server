import { randomBytes } from "node:crypto";

export interface AppConfig {
  port: number;
  publicBaseUrl: URL;
  mcpResourceUrl: URL;
  ynabClientId: string;
  ynabClientSecret: string;
  tokenEncryptionKey: Buffer;
  allowedRedirectOrigins: Set<string>;
  storeBackend: "firestore" | "memory";
  firestoreProjectId?: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseBaseUrl(value: string): URL {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/$/, "");
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("PUBLIC_BASE_URL must use HTTPS outside local development");
  }
  return url;
}

function parseEncryptionKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

export function loadConfig(): AppConfig {
  const publicBaseUrl = parseBaseUrl(required("PUBLIC_BASE_URL"));
  const backend = process.env.STORE_BACKEND === "memory" ? "memory" : "firestore";
  const allowedOrigins = (process.env.MCP_ALLOWED_REDIRECT_ORIGINS ?? "https://chatgpt.com")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    port: Number(process.env.PORT ?? "8080"),
    publicBaseUrl,
    mcpResourceUrl: new URL("/mcp", publicBaseUrl),
    ynabClientId: required("YNAB_CLIENT_ID"),
    ynabClientSecret: required("YNAB_CLIENT_SECRET"),
    tokenEncryptionKey: parseEncryptionKey(required("TOKEN_ENCRYPTION_KEY")),
    allowedRedirectOrigins: new Set(allowedOrigins),
    storeBackend: backend,
    ...(process.env.GOOGLE_CLOUD_PROJECT ? { firestoreProjectId: process.env.GOOGLE_CLOUD_PROJECT } : {}),
  };
}

export function developmentConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const publicBaseUrl = overrides.publicBaseUrl ?? new URL("http://localhost:8080");
  return {
    port: 8080,
    publicBaseUrl,
    mcpResourceUrl: new URL("/mcp", publicBaseUrl),
    ynabClientId: "test-client",
    ynabClientSecret: "test-secret",
    tokenEncryptionKey: randomBytes(32),
    allowedRedirectOrigins: new Set(["https://chatgpt.com"]),
    storeBackend: "memory",
    ...overrides,
  };
}
