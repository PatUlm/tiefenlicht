#!/usr/bin/env bash
#
# Wendet den Terraform-Stack auf den netcup1-Docker-Daemon ueber einen
# SSH-Tunnel an.
#
# Voraussetzungen:
#   - bin/release.sh gelaufen (terraform/image.auto.tfvars existiert)
#   - terraform initialisiert (task init / terraform -chdir=terraform init)
#
# Zusatzargumente werden an terraform durchgereicht (z. B. bin/deploy.sh -auto-approve).
set -euo pipefail
cd "$(dirname "$0")/.."

SSH_HOST="netcup1"
SOCKET="tl-docker-tunnel.sock"
DOCKER_SOCK="/tmp/tl-docker.sock"

if [ ! -f terraform/image.auto.tfvars ]; then
  echo "ERROR: terraform/image.auto.tfvars fehlt — zuerst bin/release.sh ausfuehren." >&2
  exit 1
fi

echo "==> Oeffne SSH-Tunnel zum Docker-Daemon (${DOCKER_SOCK} → ${SSH_HOST})"
ssh -M -S "${SOCKET}" -fnNT -L "${DOCKER_SOCK}:/var/run/docker.sock" "${SSH_HOST}"
cleanup() {
  ssh -S "${SOCKET}" -O exit "${SSH_HOST}" 2>/dev/null || true
  rm -f "${DOCKER_SOCK}"
}
trap cleanup EXIT
sleep 2

DOCKER_HOST="unix://${DOCKER_SOCK}" \
  terraform -chdir=terraform apply "$@"
