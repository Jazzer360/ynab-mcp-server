[CmdletBinding()]
param(
    [string]$ProjectId = "ynab-mcp-504216",
    [string]$Region = "us-central1"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ServiceName = "financial-analysis-for-ynab"
$RuntimeAccount = "financial-analysis-ynab"
$RuntimeEmail = "$RuntimeAccount@$ProjectId.iam.gserviceaccount.com"
$EncryptionSecret = "financial-analysis-for-ynab-encryption-key"
$YnabSecret = "financial-analysis-for-ynab-client-secret"

function Invoke-Gcloud {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

    & gcloud @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "gcloud command failed: gcloud $($Arguments -join ' ')"
    }
}

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    throw "Google Cloud CLI is required. Install it, reopen PowerShell, and run this script again."
}

$ActiveAccount = @(& gcloud auth list --filter=status:ACTIVE --format="value(account)") |
    Where-Object { $_ } |
    Select-Object -First 1
if (-not $ActiveAccount) {
    throw "No active Google Cloud account. Run 'gcloud auth login' first."
}

Invoke-Gcloud projects describe $ProjectId --format="value(projectId)"
Invoke-Gcloud config set project $ProjectId

$Apis = @(
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "firestore.googleapis.com",
    "secretmanager.googleapis.com",
    "iam.googleapis.com"
)
Invoke-Gcloud services enable @Apis

$ExistingServiceAccount = @(& gcloud iam service-accounts list `
    --filter="email=$RuntimeEmail" `
    --format="value(email)" `
    --limit=1) |
    Where-Object { $_ } |
    Select-Object -First 1
if ($LASTEXITCODE -ne 0) {
    throw "Unable to list service accounts in project $ProjectId."
}
if (-not $ExistingServiceAccount) {
    Invoke-Gcloud iam service-accounts create $RuntimeAccount `
        --display-name="Financial Analysis for YNAB runtime"
}

foreach ($Role in @("roles/datastore.user", "roles/secretmanager.secretAccessor", "roles/logging.logWriter")) {
    Invoke-Gcloud projects add-iam-policy-binding $ProjectId `
        --member="serviceAccount:$RuntimeEmail" `
        --role=$Role `
        --condition=None `
        --quiet
}

$DatabaseNames = @(& gcloud firestore databases list --format="value(name)")
if ($LASTEXITCODE -ne 0) {
    throw "Unable to list Firestore databases in project $ProjectId."
}
$DefaultDatabase = $DatabaseNames |
    Where-Object { $_ -eq "(default)" -or $_ -match "/databases/\(default\)$" } |
    Select-Object -First 1
if (-not $DefaultDatabase) {
    Invoke-Gcloud firestore databases create `
        --database="(default)" `
        --location=$Region `
        --type=firestore-native `
        --delete-protection
}

$SecretNames = @(& gcloud secrets list --format="value(name)")
if ($LASTEXITCODE -ne 0) {
    throw "Unable to list Secret Manager secrets in project $ProjectId."
}

$EncryptionSecretExists = $SecretNames |
    Where-Object { $_ -eq $EncryptionSecret -or $_ -match "/secrets/$([regex]::Escape($EncryptionSecret))$" } |
    Select-Object -First 1
if (-not $EncryptionSecretExists) {
    Invoke-Gcloud secrets create $EncryptionSecret --replication-policy=automatic

    $KeyBytes = New-Object byte[] 32
    $Random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $Random.GetBytes($KeyBytes)
    }
    finally {
        $Random.Dispose()
    }
    [Convert]::ToBase64String($KeyBytes) |
        & gcloud secrets versions add $EncryptionSecret --data-file=-
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to add the encryption-key secret version."
    }
}

$YnabSecretExists = $SecretNames |
    Where-Object { $_ -eq $YnabSecret -or $_ -match "/secrets/$([regex]::Escape($YnabSecret))$" } |
    Select-Object -First 1
if (-not $YnabSecretExists) {
    Invoke-Gcloud secrets create $YnabSecret --replication-policy=automatic
    "bootstrap-not-a-real-secret" |
        & gcloud secrets versions add $YnabSecret --data-file=-
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to add the bootstrap YNAB secret version."
    }
}

Invoke-Gcloud run deploy $ServiceName `
    --source=. `
    --region=$Region `
    --service-account=$RuntimeEmail `
    --no-invoker-iam-check `
    --ingress=all `
    --default-url `
    --max-instances=1 `
    --port=8080 `
    --set-env-vars="STORE_BACKEND=firestore,GOOGLE_CLOUD_PROJECT=$ProjectId,MCP_ALLOWED_REDIRECT_ORIGINS=https://chatgpt.com,PUBLIC_BASE_URL=https://bootstrap.invalid,YNAB_CLIENT_ID=bootstrap" `
    --set-secrets="TOKEN_ENCRYPTION_KEY=${EncryptionSecret}:latest,YNAB_CLIENT_SECRET=${YnabSecret}:latest" `
    --quiet

$ServiceUrl = & gcloud run services describe $ServiceName `
    --region=$Region `
    --format="value(status.url)"
if ($LASTEXITCODE -ne 0 -or -not $ServiceUrl) {
    throw "Unable to resolve the deployed Cloud Run URL."
}
$ServiceUrl = $ServiceUrl.Trim()

Invoke-Gcloud run services update $ServiceName `
    --region=$Region `
    --update-env-vars="PUBLIC_BASE_URL=$ServiceUrl" `
    --quiet

Write-Host ""
Write-Host "Bootstrap deployment is ready at:"
Write-Host $ServiceUrl
Write-Host ""
Write-Host "Create the YNAB OAuth application with:"
Write-Host "  Name: Financial Analysis for YNAB"
Write-Host "  Redirect URI: $ServiceUrl/oauth/ynab/callback"
Write-Host "  Privacy policy: $ServiceUrl/privacy"
Write-Host "  Website: $ServiceUrl/"
Write-Host ""
Write-Host "Then run:"
Write-Host "  .\scripts\finalize-google-cloud.ps1 -YnabClientId <YNAB_CLIENT_ID>"
