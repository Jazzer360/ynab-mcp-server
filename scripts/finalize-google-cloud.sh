#!/usr/bin/env bash
set -euo pipefail

project_id="${GOOGLE_CLOUD_PROJECT:-ynab-mcp-504216}"
region="${GOOGLE_CLOUD_REGION:-us-central1}"
service_name="financial-analysis-for-ynab"
ynab_secret_name="financial-analysis-for-ynab-client-secret"
ynab_client_id="${1:-}"

if [[ -z "${ynab_client_id}" ]]; then
  echo "Usage: $0 <YNAB_CLIENT_ID>" >&2
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "Google Cloud CLI is required." >&2
  exit 1
fi

read -r -s -p "YNAB client secret (input hidden): " ynab_client_secret
printf '\n'
if [[ -z "${ynab_client_secret}" ]]; then
  echo "The YNAB client secret cannot be empty." >&2
  exit 1
fi

printf '%s' "${ynab_client_secret}" | \
  gcloud secrets versions add "${ynab_secret_name}" --project="${project_id}" --data-file=- >/dev/null
unset ynab_client_secret

service_url="$(gcloud run services describe "${service_name}" \
  --project="${project_id}" \
  --region="${region}" \
  --format='value(status.url)')"

gcloud run services update "${service_name}" \
  --project="${project_id}" \
  --region="${region}" \
  --update-env-vars="PUBLIC_BASE_URL=${service_url},YNAB_CLIENT_ID=${ynab_client_id}" \
  --update-secrets="YNAB_CLIENT_SECRET=${ynab_secret_name}:latest" \
  --quiet >/dev/null

health_status="$(curl --silent --show-error --fail "${service_url}/health")"
printf 'Deployment finalized: %s\n' "${health_status}"
printf 'MCP endpoint: %s/mcp\n' "${service_url}"
