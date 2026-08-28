import { Router, type Request, type Response } from "express";
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import type { AppConfig } from "./config.js";
import { decryptJson, encryptJson, hashToken, pkceChallenge, randomToken, safeEqual } from "./crypto.js";
import type { RecordStore } from "./store.js";

interface OAuthClientRecord {
  clientId: string;
  clientSecretHash?: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none" | "client_secret_basic" | "client_secret_post";
  createdAt: number;
}

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  clientState: string;
  codeChallenge: string;
  resource: string;
  encryptedUpstreamVerifier: string;
  expiresAt: number;
}

interface AuthorizationCodeRecord {
  grantId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  expiresAt: number;
}

export interface YnabTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface GrantRecord {
  encryptedYnabTokens: string;
  ynabUserId: string;
  createdAt: number;
  updatedAt: number;
  revokedAt?: number;
}

interface AccessTokenRecord {
  grantId: string;
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

interface RefreshTokenRecord extends AccessTokenRecord {}

interface YnabTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

const ACCESS_TOKEN_LIFETIME_SECONDS = 60 * 60;
const REFRESH_TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 30;
const SHORT_LIVED_SECONDS = 5 * 60;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function value(input: unknown): string | undefined {
  return typeof input === "string" && input.length > 0 ? input : undefined;
}

function oauthError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

function appendOAuthError(redirectUri: string, state: string, error: string, description: string): string {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  target.searchParams.set("error_description", description);
  target.searchParams.set("state", state);
  return target.toString();
}

export class OAuthService implements OAuthTokenVerifier {
  readonly router = Router();

  constructor(
    private readonly config: AppConfig,
    private readonly store: RecordStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.router.post("/register", this.registerClient);
    this.router.get("/authorize", this.authorize);
    this.router.get("/oauth/ynab/callback", this.ynabCallback);
    this.router.post("/token", this.token);
    this.router.post("/revoke", this.revoke);
  }

  metadata() {
    return {
      issuer: this.config.publicBaseUrl.toString(),
      authorization_endpoint: new URL("/authorize", this.config.publicBaseUrl).toString(),
      token_endpoint: new URL("/token", this.config.publicBaseUrl).toString(),
      registration_endpoint: new URL("/register", this.config.publicBaseUrl).toString(),
      revocation_endpoint: new URL("/revoke", this.config.publicBaseUrl).toString(),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["ynab.read"],
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = await this.store.get<AccessTokenRecord>("access_tokens", hashToken(token));
    if (!record || record.expiresAt <= nowSeconds()) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "The access token is invalid or expired");
    }
    const grant = await this.store.get<GrantRecord>("grants", record.grantId);
    if (!grant || grant.revokedAt) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "The YNAB authorization has been revoked");
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: new URL(record.resource),
      extra: { grantId: record.grantId },
    };
  }

  async getYnabAccessToken(grantId: string): Promise<string> {
    const grant = await this.store.get<GrantRecord>("grants", grantId);
    if (!grant || grant.revokedAt) throw new Error("YNAB connection is unavailable");
    const tokens = decryptJson<YnabTokenSet>(grant.encryptedYnabTokens, this.config.tokenEncryptionKey);
    if (tokens.expiresAt > nowSeconds() + 60) return tokens.accessToken;

    const refreshed = await this.exchangeYnabToken({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
    });
    const updated: YnabTokenSet = {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token || tokens.refreshToken,
      expiresAt: nowSeconds() + refreshed.expires_in,
    };
    await this.store.put<GrantRecord>("grants", grantId, {
      ...grant,
      encryptedYnabTokens: encryptJson(updated, this.config.tokenEncryptionKey),
      updatedAt: nowSeconds(),
    });
    return updated.accessToken;
  }

  async deleteGrant(grantId: string): Promise<void> {
    await Promise.all([
      this.store.delete("grants", grantId),
      this.store.deleteWhere("access_tokens", "grantId", grantId),
      this.store.deleteWhere("refresh_tokens", "grantId", grantId),
      this.store.deleteWhere("transaction_change_checkpoints", "grantId", grantId),
    ]);
  }

  private registerClient = async (req: Request, res: Response): Promise<void> => {
    const body = req.body as Record<string, unknown>;
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((item): item is string => typeof item === "string")
      : [];
    if (redirectUris.length === 0 || !redirectUris.every((uri) => this.redirectUriAllowed(uri))) {
      oauthError(res, 400, "invalid_redirect_uri", "Every redirect URI must use an allowed HTTPS origin");
      return;
    }

    const requestedMethod = value(body.token_endpoint_auth_method) ?? "none";
    if (!new Set(["none", "client_secret_basic", "client_secret_post"]).has(requestedMethod)) {
      oauthError(res, 400, "invalid_client_metadata", "Unsupported token endpoint authentication method");
      return;
    }
    const method = requestedMethod as OAuthClientRecord["tokenEndpointAuthMethod"];
    const clientId = randomToken(24);
    const clientSecret = method === "none" ? undefined : randomToken(32);
    const record: OAuthClientRecord = {
      clientId,
      ...(clientSecret ? { clientSecretHash: hashToken(clientSecret) } : {}),
      redirectUris,
      tokenEndpointAuthMethod: method,
      createdAt: nowSeconds(),
    };
    await this.store.put("clients", clientId, record);
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: record.createdAt,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
    });
  };

  private authorize = async (req: Request, res: Response): Promise<void> => {
    const clientId = value(req.query.client_id);
    const redirectUri = value(req.query.redirect_uri);
    const state = value(req.query.state);
    const codeChallenge = value(req.query.code_challenge);
    const resource = value(req.query.resource) ?? this.config.mcpResourceUrl.toString();
    const scope = value(req.query.scope) ?? "ynab.read";
    if (!clientId || !redirectUri || !state || !codeChallenge) {
      oauthError(res, 400, "invalid_request", "client_id, redirect_uri, state, and PKCE are required");
      return;
    }
    const client = await this.store.get<OAuthClientRecord>("clients", clientId);
    if (!client || !client.redirectUris.includes(redirectUri)) {
      oauthError(res, 400, "invalid_request", "Unknown client or redirect URI");
      return;
    }
    if (req.query.response_type !== "code" || req.query.code_challenge_method !== "S256") {
      res.redirect(appendOAuthError(redirectUri, state, "invalid_request", "Authorization code with PKCE S256 is required"));
      return;
    }
    if (scope.split(/\s+/).some((item) => item !== "ynab.read")) {
      res.redirect(appendOAuthError(redirectUri, state, "invalid_scope", "Only ynab.read is supported"));
      return;
    }
    if (resource !== this.config.mcpResourceUrl.toString()) {
      res.redirect(appendOAuthError(redirectUri, state, "invalid_target", "The requested resource is not supported"));
      return;
    }

    const upstreamState = randomToken(32);
    const upstreamVerifier = randomToken(48);
    const pending: PendingAuthorization = {
      clientId,
      redirectUri,
      clientState: state,
      codeChallenge,
      resource,
      encryptedUpstreamVerifier: encryptJson(upstreamVerifier, this.config.tokenEncryptionKey),
      expiresAt: nowSeconds() + SHORT_LIVED_SECONDS,
    };
    await this.store.put("pending_auth", hashToken(upstreamState), pending);

    const target = new URL("https://app.ynab.com/oauth/authorize");
    target.searchParams.set("client_id", this.config.ynabClientId);
    target.searchParams.set("redirect_uri", new URL("/oauth/ynab/callback", this.config.publicBaseUrl).toString());
    target.searchParams.set("response_type", "code");
    target.searchParams.set("scope", "read-only");
    target.searchParams.set("state", upstreamState);
    target.searchParams.set("code_challenge", pkceChallenge(upstreamVerifier));
    target.searchParams.set("code_challenge_method", "S256");
    res.redirect(target.toString());
  };

  private ynabCallback = async (req: Request, res: Response): Promise<void> => {
    const upstreamState = value(req.query.state);
    if (!upstreamState) {
      oauthError(res, 400, "invalid_request", "Missing OAuth state");
      return;
    }
    const pending = await this.store.take<PendingAuthorization>("pending_auth", hashToken(upstreamState));
    if (!pending || pending.expiresAt <= nowSeconds()) {
      oauthError(res, 400, "invalid_grant", "Authorization request is invalid or expired");
      return;
    }
    if (typeof req.query.error === "string") {
      res.redirect(appendOAuthError(pending.redirectUri, pending.clientState, req.query.error, "YNAB authorization was not completed"));
      return;
    }
    const code = value(req.query.code);
    if (!code) {
      res.redirect(appendOAuthError(pending.redirectUri, pending.clientState, "invalid_grant", "YNAB did not return an authorization code"));
      return;
    }

    try {
      const upstreamVerifier = decryptJson<string>(pending.encryptedUpstreamVerifier, this.config.tokenEncryptionKey);
      const response = await this.exchangeYnabToken({
        grant_type: "authorization_code",
        code,
        redirect_uri: new URL("/oauth/ynab/callback", this.config.publicBaseUrl).toString(),
        code_verifier: upstreamVerifier,
      });
      const tokens: YnabTokenSet = {
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
        expiresAt: nowSeconds() + response.expires_in,
      };
      const userResponse = await this.fetchImpl("https://api.ynab.com/v1/user", {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      if (!userResponse.ok) throw new Error(`YNAB user lookup failed with status ${userResponse.status}`);
      const userPayload = (await userResponse.json()) as { data?: { user?: { id?: string } } };
      const ynabUserId = userPayload.data?.user?.id;
      if (!ynabUserId) throw new Error("YNAB user lookup did not return an identifier");

      const grantId = randomToken(24);
      await this.store.put<GrantRecord>("grants", grantId, {
        encryptedYnabTokens: encryptJson(tokens, this.config.tokenEncryptionKey),
        ynabUserId,
        createdAt: nowSeconds(),
        updatedAt: nowSeconds(),
      });
      const authorizationCode = randomToken(32);
      await this.store.put<AuthorizationCodeRecord>("authorization_codes", hashToken(authorizationCode), {
        grantId,
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        resource: pending.resource,
        expiresAt: nowSeconds() + SHORT_LIVED_SECONDS,
      });
      const target = new URL(pending.redirectUri);
      target.searchParams.set("code", authorizationCode);
      target.searchParams.set("state", pending.clientState);
      res.redirect(target.toString());
    } catch {
      res.redirect(appendOAuthError(pending.redirectUri, pending.clientState, "server_error", "The YNAB connection could not be completed"));
    }
  };

  private token = async (req: Request, res: Response): Promise<void> => {
    const body = req.body as Record<string, unknown>;
    const client = await this.authenticateClient(req, body);
    if (!client) {
      res.setHeader("WWW-Authenticate", 'Basic realm="token"');
      oauthError(res, 401, "invalid_client", "Client authentication failed");
      return;
    }
    const grantType = value(body.grant_type);
    if (grantType === "authorization_code") {
      await this.exchangeAuthorizationCode(client, body, res);
      return;
    }
    if (grantType === "refresh_token") {
      await this.exchangeRefreshToken(client, body, res);
      return;
    }
    oauthError(res, 400, "unsupported_grant_type", "Unsupported grant type");
  };

  private revoke = async (req: Request, res: Response): Promise<void> => {
    const body = req.body as Record<string, unknown>;
    const client = await this.authenticateClient(req, body);
    if (!client) {
      oauthError(res, 401, "invalid_client", "Client authentication failed");
      return;
    }
    const tokenValue = value(body.token);
    if (tokenValue) {
      const tokenId = hashToken(tokenValue);
      const access = await this.store.get<AccessTokenRecord>("access_tokens", tokenId);
      const refresh = await this.store.get<RefreshTokenRecord>("refresh_tokens", tokenId);
      if (access?.clientId === client.clientId) await this.store.delete("access_tokens", tokenId);
      if (refresh?.clientId === client.clientId) await this.store.delete("refresh_tokens", tokenId);
    }
    res.status(200).end();
  };

  private async exchangeAuthorizationCode(
    client: OAuthClientRecord,
    body: Record<string, unknown>,
    res: Response,
  ): Promise<void> {
    const code = value(body.code);
    const verifier = value(body.code_verifier);
    const redirectUri = value(body.redirect_uri);
    if (!code || !verifier || !redirectUri) {
      oauthError(res, 400, "invalid_request", "code, code_verifier, and redirect_uri are required");
      return;
    }
    const record = await this.store.take<AuthorizationCodeRecord>("authorization_codes", hashToken(code));
    if (
      !record ||
      record.expiresAt <= nowSeconds() ||
      record.clientId !== client.clientId ||
      record.redirectUri !== redirectUri ||
      !safeEqual(pkceChallenge(verifier), record.codeChallenge)
    ) {
      oauthError(res, 400, "invalid_grant", "Authorization code is invalid or expired");
      return;
    }
    const tokens = await this.issueMcpTokens(record.grantId, client.clientId, record.resource);
    res.json(tokens);
  }

  private async exchangeRefreshToken(
    client: OAuthClientRecord,
    body: Record<string, unknown>,
    res: Response,
  ): Promise<void> {
    const refreshToken = value(body.refresh_token);
    if (!refreshToken) {
      oauthError(res, 400, "invalid_request", "refresh_token is required");
      return;
    }
    const record = await this.store.take<RefreshTokenRecord>("refresh_tokens", hashToken(refreshToken));
    if (!record || record.expiresAt <= nowSeconds() || record.clientId !== client.clientId) {
      oauthError(res, 400, "invalid_grant", "Refresh token is invalid or expired");
      return;
    }
    res.json(await this.issueMcpTokens(record.grantId, client.clientId, record.resource));
  }

  private async issueMcpTokens(grantId: string, clientId: string, resource: string) {
    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);
    const accessRecord: AccessTokenRecord = {
      grantId,
      clientId,
      scopes: ["ynab.read"],
      resource,
      expiresAt: nowSeconds() + ACCESS_TOKEN_LIFETIME_SECONDS,
    };
    const refreshRecord: RefreshTokenRecord = {
      ...accessRecord,
      expiresAt: nowSeconds() + REFRESH_TOKEN_LIFETIME_SECONDS,
    };
    await Promise.all([
      this.store.put("access_tokens", hashToken(accessToken), accessRecord),
      this.store.put("refresh_tokens", hashToken(refreshToken), refreshRecord),
    ]);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
      refresh_token: refreshToken,
      scope: "ynab.read",
    };
  }

  private async authenticateClient(
    req: Request,
    body: Record<string, unknown>,
  ): Promise<OAuthClientRecord | undefined> {
    let clientId = value(body.client_id);
    let clientSecret = value(body.client_secret);
    const authorization = req.header("authorization");
    if (authorization?.startsWith("Basic ")) {
      try {
        const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
        const separator = decoded.indexOf(":");
        if (separator >= 0) {
          clientId = decodeURIComponent(decoded.slice(0, separator));
          clientSecret = decodeURIComponent(decoded.slice(separator + 1));
        }
      } catch {
        return undefined;
      }
    }
    if (!clientId) return undefined;
    const client = await this.store.get<OAuthClientRecord>("clients", clientId);
    if (!client) return undefined;
    if (client.tokenEndpointAuthMethod === "none") return client;
    if (!clientSecret || !client.clientSecretHash) return undefined;
    return safeEqual(hashToken(clientSecret), client.clientSecretHash) ? client : undefined;
  }

  private redirectUriAllowed(uri: string): boolean {
    try {
      const parsed = new URL(uri);
      return parsed.protocol === "https:" && this.config.allowedRedirectOrigins.has(parsed.origin);
    } catch {
      return false;
    }
  }

  private async exchangeYnabToken(parameters: Record<string, string>): Promise<YnabTokenResponse> {
    const body = new URLSearchParams({
      client_id: this.config.ynabClientId,
      client_secret: this.config.ynabClientSecret,
      ...parameters,
    });
    const response = await this.fetchImpl("https://app.ynab.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) throw new Error(`YNAB token exchange failed with status ${response.status}`);
    return (await response.json()) as YnabTokenResponse;
  }
}
