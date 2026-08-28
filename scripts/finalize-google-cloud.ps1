[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$YnabClientId,
    [string]$ProjectId = "ynab-mcp-504216",
    [string]$Region = "us-central1"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ServiceName = "financial-analysis-for-ynab"
$YnabSecretName = "financial-analysis-for-ynab-client-secret"

function Invoke-Gcloud {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

    & gcloud @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "gcloud command failed: gcloud $($Arguments -join ' ')"
    }
}

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    throw "Google Cloud CLI is required."
}

$SecureSecret = Read-Host "YNAB client secret (input hidden)" -AsSecureString
$SecretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureSecret)
try {
    $PlainSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($SecretPointer)
    if ([string]::IsNullOrWhiteSpace($PlainSecret)) {
        throw "The YNAB client secret cannot be empty."
    }

    $PlainSecret |
        & gcloud secrets versions add $YnabSecretName --project=$ProjectId --data-file=-
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to add the YNAB client-secret version."
    }
}
finally {
    if ($SecretPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($SecretPointer)
    }
    $PlainSecret = $null
    $SecureSecret = $null
}

$ServiceUrl = & gcloud run services describe $ServiceName `
    --project=$ProjectId `
    --region=$Region `
    --format="value(status.url)"
if ($LASTEXITCODE -ne 0 -or -not $ServiceUrl) {
    throw "Unable to resolve the deployed Cloud Run URL."
}
$ServiceUrl = $ServiceUrl.Trim()

Invoke-Gcloud run services update $ServiceName `
    --project=$ProjectId `
    --region=$Region `
    --update-env-vars="PUBLIC_BASE_URL=$ServiceUrl,YNAB_CLIENT_ID=$YnabClientId" `
    --update-secrets="YNAB_CLIENT_SECRET=${YnabSecretName}:latest" `
    --quiet

$HealthStatus = Invoke-RestMethod -Uri "$ServiceUrl/health" -Method Get
Write-Host "Deployment finalized: $($HealthStatus | ConvertTo-Json -Compress)"
Write-Host "MCP endpoint: $ServiceUrl/mcp"
