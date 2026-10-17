#!/usr/bin/env bash
# Deploys the service to Cloud Run and the dashboard to Firebase Hosting.
#
# Prereqs: gcloud and firebase CLIs logged in, billing enabled on the project.
# Usage:   PROJECT_ID=my-project GEMINI_API_KEY=... ./scripts/deploy.sh
#          (REGION defaults to asia-south1; must match firebase.json rewrites)
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-agent-checkout-guard}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-2.5-flash}"

cd "$(dirname "$0")/.."

echo "==> Project $PROJECT_ID, region $REGION"
gcloud config set project "$PROJECT_ID" >/dev/null

echo "==> Enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com firebase.googleapis.com aiplatform.googleapis.com >/dev/null

echo "==> Firestore database (native mode) if missing"
if ! gcloud firestore databases describe --database='(default)' >/dev/null 2>&1; then
  gcloud firestore databases create --location="$REGION" --type=firestore-native
fi

ENV_VARS="GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GEMINI_MODEL=$GEMINI_MODEL"
if [[ -n "${GEMINI_API_KEY:-}" ]]; then
  echo "==> Storing GEMINI_API_KEY in Secret Manager"
  gcloud services enable secretmanager.googleapis.com >/dev/null
  if ! gcloud secrets describe gemini-api-key >/dev/null 2>&1; then
    printf '%s' "$GEMINI_API_KEY" | gcloud secrets create gemini-api-key --data-file=-
  else
    printf '%s' "$GEMINI_API_KEY" | gcloud secrets versions add gemini-api-key --data-file=-
  fi
  SECRET_FLAG=(--set-secrets "GEMINI_API_KEY=gemini-api-key:latest")
else
  echo "==> No GEMINI_API_KEY given; using Vertex AI with the service identity"
  ENV_VARS="$ENV_VARS,GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_LOCATION=${VERTEX_LOCATION:-us-central1}"
  SECRET_FLAG=()
fi
if [[ -n "${ADMIN_TOKEN:-}" ]]; then ENV_VARS="$ENV_VARS,ADMIN_TOKEN=$ADMIN_TOKEN"; fi

echo "==> Deploying to Cloud Run (source build)"
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --min-instances 1 \
  --memory 512Mi \
  --set-env-vars "$ENV_VARS" \
  "${SECRET_FLAG[@]}"

RUN_URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"
echo "==> Cloud Run URL: $RUN_URL"
# The buyer agent calls sellers over HTTP; point it at the service's own URL.
gcloud run services update "$SERVICE" --region "$REGION" --update-env-vars "SELF_ORIGIN=$RUN_URL" >/dev/null

echo "==> Granting the service identity access to Firestore, Secret Manager and Vertex AI"
SA="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(spec.template.spec.serviceAccountName)')"
SA="${SA:-$(gcloud projects describe "$PROJECT_ID" --format 'value(projectNumber)')-compute@developer.gserviceaccount.com}"
for ROLE in roles/datastore.user roles/secretmanager.secretAccessor roles/aiplatform.user; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$SA" --role "$ROLE" --condition=None >/dev/null
done

echo "==> Firebase Hosting + Firestore rules and indexes"
if [[ ! -f .firebaserc ]]; then
  sed "s/YOUR_GCP_PROJECT_ID/$PROJECT_ID/" .firebaserc.example > .firebaserc
fi
firebase projects:addfirebase "$PROJECT_ID" >/dev/null 2>&1 || true
firebase deploy --project "$PROJECT_ID" --only hosting,firestore

echo
echo "Done."
echo "  Dashboard : https://$PROJECT_ID.web.app"
echo "  Service   : $RUN_URL"
echo "  Discovery : $RUN_URL/sellers/pelican_mail/.well-known/ucp"
