# Deploy the browser connector

The server is designed for a private Google Cloud Run deployment backed by Firestore. It must be publicly reachable because ChatGPT and YNAB need to complete OAuth redirects, but every MCP request is protected by OAuth and the YNAB grant requests only `read-only` access.

Do not paste the YNAB client secret, token-encryption key, authorization codes, or access tokens into ChatGPT.

## Project defaults

This copy is configured for:

- Google Cloud project: `ynab-mcp-504216`
- Region: `us-central1`
- Cloud Run service: `financial-analysis-for-ynab`

The quickest deployment route is to open this directory in an authenticated Google Cloud Shell and run:

```bash
chmod +x scripts/*.sh
./scripts/bootstrap-google-cloud.sh
```

The bootstrap script safely reuses resources that already exist. It enables the required APIs, creates a least-privilege runtime service account, creates the default Firestore database and encrypted secrets when absent, deploys the service, and prints the exact YNAB OAuth registration URLs.

### Update an existing deployment

When the Google Cloud resources and OAuth application already exist, deploy code updates from this directory without rerunning either setup script:

```powershell
gcloud run deploy financial-analysis-for-ynab `
  --source=. `
  --project=ynab-mcp-504216 `
  --region=us-central1 `
  --quiet
```

This preserves the service's environment variables, secret mappings, service account, URL, and OAuth registrations. After deployment, open the developer-mode plugin in ChatGPT and select **Refresh** so ChatGPT discovers newly added tools. Existing YNAB authorization remains valid.

### Windows PowerShell

Install the Google Cloud CLI, extract the deployment bundle, and open PowerShell in the extracted directory. Then run:

```powershell
gcloud auth login
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\bootstrap-google-cloud.ps1
```

`Set-ExecutionPolicy -Scope Process` affects only the current PowerShell process. If your organization prevents it, run the signed-script workflow required by your administrator instead.

## 1. Prepare Google Cloud

Choose a project and region, enable Cloud Run, Cloud Build, Artifact Registry, Firestore, IAM, and Secret Manager, and create a dedicated runtime service account. Grant that account only:

- `roles/datastore.user`
- `roles/secretmanager.secretAccessor`
- `roles/logging.logWriter`

Create a Firestore database in Native mode. Keep the Cloud Run service at one maximum instance initially so only one process refreshes a YNAB grant at a time. The provided bootstrap script performs these steps idempotently.

Create a 32-byte encryption key and store it in Secret Manager as `financial-analysis-for-ynab-encryption-key`. Generate it locally with a cryptographically secure random generator; never reuse the YNAB client secret as this key.

## 2. Bootstrap the Cloud Run URL

Deploy from this directory with the included Dockerfile. The first deployment may use non-secret bootstrap values for `PUBLIC_BASE_URL`, `YNAB_CLIENT_ID`, and `YNAB_CLIENT_SECRET`; they only allow the container to start and cannot authorize YNAB.

Use these runtime settings:

- `STORE_BACKEND=firestore`
- `MCP_ALLOWED_REDIRECT_ORIGINS=https://chatgpt.com`
- `TOKEN_ENCRYPTION_KEY` mapped from the encryption-key secret
- Dedicated runtime service account
- Unauthenticated network ingress enabled; application OAuth still protects `/mcp`
- Maximum instances set to `1`

After deployment, obtain the exact HTTPS service URL from Cloud Run. Set `PUBLIC_BASE_URL` to that URL without a trailing slash. The bootstrap script performs this second update automatically after Cloud Run assigns the URL.

## 3. Create the YNAB OAuth application

In YNAB Developer Settings, create an OAuth application named **Financial Analysis for YNAB** with:

- Redirect URI: `<PUBLIC_BASE_URL>/oauth/ynab/callback`
- Privacy policy: `<PUBLIC_BASE_URL>/privacy`
- Application website: `<PUBLIC_BASE_URL>/`

Store the YNAB client secret in Secret Manager as `financial-analysis-for-ynab-client-secret`. Configure Cloud Run with the returned client ID and map `YNAB_CLIENT_SECRET` from that secret. The server automatically requests YNAB's `read-only` scope, authorization-code flow, refresh tokens, `state`, and PKCE S256.

After YNAB shows the client ID and secret, run the following in the same terminal. The script prompts for the secret with hidden input and sends it directly to Secret Manager:

```bash
./scripts/finalize-google-cloud.sh <YNAB_CLIENT_ID>
```

On Windows PowerShell, use:

```powershell
.\scripts\finalize-google-cloud.ps1 -YnabClientId <YNAB_CLIENT_ID>
```

## 4. Verify the deployment

Check these public endpoints before installing the plugin:

- `<PUBLIC_BASE_URL>/health` returns `{"status":"ok"}`.
- `<PUBLIC_BASE_URL>/privacy` displays the current data policy.
- `<PUBLIC_BASE_URL>/.well-known/oauth-protected-resource/mcp` identifies the MCP resource and authorization server.
- `<PUBLIC_BASE_URL>/.well-known/oauth-authorization-server` advertises authorization, token, registration, and revocation endpoints.

Do not test by manually copying authorization codes or tokens. Use an OAuth-capable MCP client so PKCE and state validation remain intact.

## 5. Connect the plugin

Replace `.mcp.json` with the deployed HTTPS endpoint:

```json
{
  "mcpServers": {
    "financial-analysis-for-ynab": {
      "type": "http",
      "url": "https://your-deployed-host.example/mcp"
    }
  }
}
```

Also add the deployed website and privacy-policy URLs to `.codex-plugin/plugin.json`, validate the plugin, and then submit or install it through a plugin surface that supports ChatGPT Work on the web.

## 6. Revoke and delete

Disconnecting the plugin should revoke its MCP token. An authenticated client can call `DELETE /connection` to delete the stored grant and both connector token families. The user can independently revoke the upstream authorization from YNAB Developer Settings.
