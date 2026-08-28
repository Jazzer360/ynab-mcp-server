#!/usr/bin/env bash
set -euo pipefail

project_id="${GOOGLE_CLOUD_PROJECT:-ynab-mcp-504216}"
region="${GOOGLE_CLOUD_REGION:-us-central1}"
service_name="financial-analysis-for-ynab"
runtime_account="financial-analysis-ynab"
runtime_email="${runtime_account}@${project_id}.iam.gserviceaccount.com"
encryption_secret="financial-analysis-for-ynab-encryption-key"
ynab_secret="financial-analysis-for-ynab-client-secret"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "Google Cloud CLI is required. Run this script from Google Cloud Shell or a machine with gcloud installed." >&2
  exit 1
fi

active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1)"
if [[ -z "${active_account}" ]]; then
  echo "No active Google Cloud account. Authenticate with gcloud before running this script." >&2
  exit 1
fi

gcloud projects describe "${project_id}" --format='value(projectId)' >/dev/null
gcloud config set project "${project_id}" >/dev/null

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com

if ! gcloud iam service-accounts describe "${runtime_email}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${runtime_account}" \
    --display-name="Financial Analysis for YNAB runtime"
fi

for role in roles/datastore.user roles/secretmanager.secretAccessor roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "${project_id}" \
    --member="serviceAccount:${runtime_email}" \
    --role="${role}" \
    --condition=None \
    --quiet >/dev/null
done

if ! gcloud firestore databases describe --database='(default)' >/dev/null 2>&1; then
  gcloud firestore databases create \
    --database='(default)' \
    --location="${region}" \
    --type=firestore-native \
    --delete-protection
fi

if ! gcloud secrets describe "${encryption_secret}" >/dev/null 2>&1; then
  gcloud secrets create "${encryption_secret}" --replication-policy=automatic
  openssl rand -base64 32 | gcloud secrets versions add "${encryption_secret}" --data-file=- >/dev/null
fi

if ! gcloud secrets describe "${ynab_secret}" >/dev/null 2>&1; then
  gcloud secrets create "${ynab_secret}" --replication-policy=automatic
  printf '%s' 'bootstrap-not-a-real-secret' | gcloud secrets versions add "${ynab_secret}" --data-file=- >/dev/null
fi

gcloud run deploy "${service_name}" \
  --source=. \
  --region="${region}" \
  --service-account="${runtime_email}" \
  --no-invoker-iam-check \
  --ingress=all \
  --default-url \
  --max-instances=1 \
  --port=8080 \
  --set-env-vars="STORE_BACKEND=firestore,GOOGLE_CLOUD_PROJECT=${project_id},MCP_ALLOWED_REDIRECT_ORIGINS=https://chatgpt.com,PUBLIC_BASE_URL=https://bootstrap.invalid,YNAB_CLIENT_ID=bootstrap" \
  --set-secrets="TOKEN_ENCRYPTION_KEY=${encryption_secret}:latest,YNAB_CLIENT_SECRET=${ynab_secret}:latest" \
  --quiet

service_url="$(gcloud run services describe "${service_name}" --region="${region}" --format='value(status.url)')"

gcloud run services update "${service_name}" \
  --region="${region}" \
  --update-env-vars="PUBLIC_BASE_URL=${service_url}" \
  --quiet >/dev/null

cat <<EOF

Bootstrap deployment is ready at:
${service_url}

Create the YNAB OAuth application with:
  Name: Financial Analysis for YNAB
  Redirect URI: ${service_url}/oauth/ynab/callback
  Privacy policy: ${service_url}/privacy
  Website: ${service_url}/

Then run:
  ./scripts/finalize-google-cloud.sh <YNAB_CLIENT_ID>
EOF
