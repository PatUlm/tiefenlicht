locals {
  project       = "tiefenlicht"
  hostname      = "tiefenlicht.nieda.de"
  proxy_network = "proxy-manager"
}

# Lokaler Image-Tag (repo:tag), von bin/release.sh auf dem netcup1-Daemon gebaut.
# Kein Registry: das Image wird auf demselben Daemon gebaut, der den Container
# betreibt, und daher direkt referenziert. Wird pro Release in image.auto.tfvars
# geschrieben.
variable "image" {
  type        = string
  description = "Lokaler Image-Tag, z. B. tiefenlicht:20260930-0900"
}

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = ">= 3.0.2"
    }
  }

  # Partielle Backend-Config: bucket/key/region werden beim init aus einer
  # gitignoreten backend.hcl geliefert (terraform init -backend-config=backend.hcl),
  # damit der State-Ort nicht eingecheckt ist. Siehe backend.hcl.example.
  backend "s3" {}
}

provider "docker" {}

resource "docker_container" "web" {
  name = "tiefenlicht_web"
  # Lokal gebautes Image direkt betreiben (kein Registry): release.sh baut es auf
  # diesem Daemon, der Tag existiert also bereits hier. Ein neues Release erzeugt
  # einen eindeutigen Tag, aendert var.image und legt den Container neu an; das
  # vorherige Image bleibt fuer Rollback auf dem Daemon bis `docker image prune`.
  # Achtung: Spiele liegen nur im Speicher, ein Release beendet laufende Partien.
  image   = var.image
  restart = "unless-stopped"

  env = [
    "TZ=Europe/Berlin",
    # WebSocket-Origin-Pruefung: nur Seiten dieser Domain duerfen Spiel-Sockets oeffnen.
    "ALLOWED_ORIGINS=https://${local.hostname}",
  ]

  labels {
    label = "project"
    value = local.project
  }
  labels {
    label = "traefik.enable"
    value = "true"
  }
  labels {
    label = "traefik.docker.network"
    value = local.proxy_network
  }
  labels {
    label = "traefik.http.routers.tiefenlicht.entrypoints"
    value = "web, websecure"
  }
  labels {
    label = "traefik.http.routers.tiefenlicht.rule"
    value = "Host(`${local.hostname}`)"
  }
  # Ein Port fuer Client (HTTP) und Spiel-Server (WebSocket unter /ws).
  labels {
    label = "traefik.http.services.tiefenlicht.loadbalancer.server.port"
    value = "8080"
  }
  labels {
    label = "traefik.http.routers.tiefenlicht.tls"
    value = "true"
  }
  labels {
    label = "traefik.http.routers.tiefenlicht.tls.certresolver"
    value = "production"
  }

  network_mode = "bridge"
  networks_advanced {
    name = local.proxy_network
  }
}
