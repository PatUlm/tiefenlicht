#!/usr/bin/env bash
#
# Zeigt den Terraform-Plan gegen den netcup1-Docker-Daemon ueber einen
# SSH-Tunnel (read-only, `terraform plan`). Immer vor bin/deploy.sh pruefen.
set -euo pipefail
cd "$(dirname "$0")/.."

SSH_HOST="netcup1"
SOCKET="tl-docker-tunnel-plan.sock"
DOCKER_SOCK="/tmp/tl-docker-plan.sock"

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
  terraform -chdir=terraform plan "$@"
