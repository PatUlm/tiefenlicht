#!/usr/bin/env bash
#
# Baut das Image auf dem netcup1-Server und schreibt terraform/image.auto.tfvars,
# sodass das anschliessende deploy.sh exakt den eben gebauten Tag ausrollt.
#
# Kein Registry: das Image wird auf demselben Docker-Daemon gebaut, der den
# Container betreibt (DOCKER_HOST=ssh://netcup1), Terraform referenziert also den
# frischen lokalen Tag direkt. Das vorherige Image bleibt zum Rollback auf dem
# Daemon, bis `docker image prune` laeuft.
#
# DOCKER_HOST=ssh://netcup1 ist ein `ssh ... docker system dial-stdio` exec (KEIN
# `ssh -L` Port-Forward): nur der (per .dockerignore gefilterte) Build-Kontext
# geht ueber SSH, node:24-slim und die npm-Pakete zieht der Server selbst.
#
# DOCKER_BUILDKIT=0 erzwingt den klassischen Builder ueber eine einzelne
# API-Verbindung; buildx+ssh:// wuerde eine Flut von SSH-Verbindungen oeffnen,
# die sshd (MaxStartups/fail2ban) abweist. Das Dockerfile nutzt keine
# BuildKit-only-Features. Der Build fuehrt `pnpm test` aus und bricht bei roten
# Tests ab.
#
# Voraussetzung: lauffaehiges lokales docker-CLI. Test:
#   DOCKER_HOST=ssh://netcup1 docker version
#
# Usage: bin/release.sh [version]   (Default: YYYYMMDD-HHMM)
set -euo pipefail
cd "$(dirname "$0")/.."

APP_VERSION="${1:-$(date +'%Y%m%d-%H%M')}"
REPO="tiefenlicht"
IMAGE="${REPO}:${APP_VERSION}"
export DOCKER_HOST="ssh://netcup1"
export DOCKER_BUILDKIT=0

echo "==> Baue ${IMAGE} auf dem Server (DOCKER_HOST=${DOCKER_HOST})"
docker build -f Dockerfile --build-arg "APP_VERSION=${APP_VERSION}" -t "${IMAGE}" -t "${REPO}:latest" .

echo "image = \"${IMAGE}\"" > terraform/image.auto.tfvars
echo
echo "==> ${IMAGE} gebaut (auf dem netcup1-Daemon behalten, kein Registry-Push)"
echo "    terraform/image.auto.tfvars aktualisiert — jetzt bin/deploy.sh ausfuehren."
