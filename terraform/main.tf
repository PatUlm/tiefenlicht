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

# Basic-Auth: die ganze Seite (Client, /ws, /healthz) nur fuer die Familie.
# htpasswd-Zeile(n) mit bcrypt (htpasswd -nB <user>), mehrere durch Komma getrennt.
# Steht in der gitignoreten auth.auto.tfvars; der Hash landet trotzdem im State
# und in den Container-Labels.
variable "basic_auth_users" {
  type        = string
  sensitive   = true
  description = "htpasswd-Eintraege (bcrypt) fuer die Traefik-basicauth-Middleware"

  validation {
    condition     = alltrue([for entry in split(",", var.basic_auth_users) : can(regex("^[^:,]+:\\$2[aby]\\$[0-9]{2}\\$[./A-Za-z0-9]{53}$", entry))])
    error_message = "Erwartet htpasswd-Zeilen mit bcrypt-Hash (user:$2y$...)."
  }
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
  # Ein Router fuer alles: die Middleware schuetzt Client, WebSocket und /healthz.
  # Der Docker-Healthcheck laeuft containerintern und ist nicht betroffen.
  labels {
    label = "traefik.http.routers.tiefenlicht.middlewares"
    value = "tiefenlicht-auth"
  }
  labels {
    label = "traefik.http.middlewares.tiefenlicht-auth.basicauth.users"
    value = var.basic_auth_users
  }
  labels {
    label = "traefik.http.middlewares.tiefenlicht-auth.basicauth.realm"
    value = "Tiefenlicht"
  }
  # Authorization-Header nicht an den Spiel-Server weiterreichen.
  labels {
    label = "traefik.http.middlewares.tiefenlicht-auth.basicauth.removeheader"
    value = "true"
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
