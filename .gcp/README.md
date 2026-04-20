# .gcp — Google Cloud credentials

Place your Vertex AI service account key here as:

    service-account.json

This file is git-ignored (see `.gcp/.gitignore`). Never commit it.

## Service account setup

1. Create a GCP project at https://console.cloud.google.com
2. Enable **Vertex AI API** and **Cloud Resource Manager API**
3. IAM & Admin → Service Accounts → Create
4. Role: **Vertex AI User**
5. Keys → Add Key → JSON → download → save here as `service-account.json`
6. Tell video-studio the project ID: set `GCP_PROJECT_ID` env var or add to `.gcp/config.json`
