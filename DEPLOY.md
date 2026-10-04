# Deployment-Anleitung — tiefenlicht.nieda.de

Runbook für das Ausrollen von Tiefenlicht auf **netcup1**. Für die tägliche
Entwicklung reicht `pnpm dev` (siehe README) — dieses Dokument betrifft nur das
produktive Deployment. Das Muster entspricht `gehrung-schifterschnitt`.

## Zielumgebung

| Was | Wert |
|-----|------|
| Domain | `tiefenlicht.nieda.de` (nur für die Familie: Basic-Auth vor der ganzen Seite inkl. `/ws` und `/healthz`) |
| Server | `netcup1` (SSH-Host aus `~/.ssh/config`) |
| Laufzeit | Docker-Container `tiefenlicht_web` (node:24-slim, Port 8080: Client + WebSocket `/ws`) |
| Reverse-Proxy | Traefik im Docker-Netz `proxy-manager`, TLS via Certresolver `production` |
| Verwaltung | Terraform (`terraform/main.tf`), State im S3-Bucket (`terraform/backend.hcl`) |

## Wie es funktioniert (Mechanik)

Es gibt **keine Container-Registry**. Das Image wird auf demselben Docker-Daemon
gebaut, der es auch betreibt, und von Terraform direkt über seinen lokalen Tag
referenziert. Zwei verschiedene SSH-Mechanismen sind im Spiel:

- **`bin/release.sh` – Build:** `DOCKER_HOST=ssh://netcup1` schickt nur den (per
  `.dockerignore` gefilterten) Build-Kontext über eine einzelne SSH-Verbindung.
  `node:24-slim` und die npm-Pakete zieht der Server selbst. Der Build führt
  `pnpm test` aus und bricht bei roten Tests ab. `DOCKER_BUILDKIT=0` erzwingt den
  klassischen Builder — buildx über `ssh://` würde eine SSH-Verbindungsflut
  auslösen, die `sshd` (MaxStartups/fail2ban) abweist. Danach schreibt das Skript
  den frischen Tag nach `terraform/image.auto.tfvars`.
- **`bin/plan.sh` / `bin/deploy.sh` – Terraform:** öffnen einen echten SSH-Tunnel
  (`ssh -L`) auf den Docker-Socket des Servers und lassen `terraform plan`/`apply`
  gegen `unix://…` laufen. Der Tunnel wird per Trap wieder geschlossen.

Ein neues Release erzeugt einen **eindeutigen Tag** (Default `YYYYMMDD-HHMM`),
ändert `var.image` und legt den Container neu an. Das **vorherige Image bleibt zum
Rollback** auf dem Daemon, bis jemand `docker image prune` ausführt.

> **Laufende Partien:** Spiele liegen nur im Speicher. Jedes Release (und jeder
> Rollback) beendet alle laufenden Partien; offene Clients kehren mit einem Hinweis
> in die Lobby zurück.

> Hinweis: Deployt wird der **Arbeitsstand** (der Build-Kontext), nicht ein
> Git-Tag. Also **vor dem Release committen**, damit die ausgerollte Version dem
> Repo entspricht. Der Tag erscheint unter `/healthz`.

## Voraussetzungen (einmalig pro Maschine)

```bash
DOCKER_HOST=ssh://netcup1 docker version   # muss Client UND Server zeigen
```

- Lokales `docker`-CLI und SSH-Zugang zum Host `netcup1` (`~/.ssh/config`).
- AWS-Credentials für das S3-Backend (State-Zugriff).
- `terraform/backend.hcl` vorhanden (aus `backend.hcl.example` kopieren), dann
  Terraform initialisieren:

```bash
task init          # = terraform -chdir=terraform init -backend-config=backend.hcl
```

- `terraform/auth.auto.tfvars` (gitignoriert) mit dem Basic-Auth-Zugang für die
  Traefik-Middleware, als htpasswd-Zeile mit bcrypt:

```bash
htpasswd -nB familie   # fragt das Passwort ab, gibt familie:$2y$... aus
# terraform/auth.auto.tfvars:
# basic_auth_users = "familie:$2y$..."
```

## Standard-Ablauf

```bash
# 0. Tests müssen grün sein (laufen zusätzlich im Image-Build)
pnpm test && pnpm typecheck

# 1. committen (Deploy nutzt den Arbeitsstand, nicht Git — aber der Stand soll passen)
git add -A && git commit

# 2. Image auf netcup1 bauen -> schreibt terraform/image.auto.tfvars
task release                       # optional fester Tag: task release -- 20260930-1200

# 3. Terraform-Plan ansehen (read-only) — erwartet: Container mit neuem image-Tag ersetzen
task plan

# 4. anwenden
task deploy                        # nicht-interaktiv: task deploy -- -auto-approve
```

Oder in einem Rutsch (Build → Plan → Apply):

```bash
task deploy-full
```

## Nach dem Deploy verifizieren

```bash
curl -s -u familie https://tiefenlicht.nieda.de/healthz    # fragt das Passwort ab; {"ok":true,"games":0,"version":"<Tag>"}
```

Der Tag muss dem eben gebauten entsprechen. Beim allerersten Deploy eines Hostnamens
liefert Traefik für einige Sekunden sein Standardzertifikat, bis Let's Encrypt
ausgestellt hat.

## Konfiguration im Container

| Variable | Wert | Zweck |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://tiefenlicht.nieda.de` | WebSocket-Origin-Prüfung (zusätzlich zum Host-Vergleich) |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | im Image gesetzt |
| `APP_VERSION` | Release-Tag | per `--build-arg`, erscheint unter `/healthz` |

## Rollback

Die vorherigen Images liegen noch auf dem Server. Rollback = alten Tag ausrollen:

```bash
DOCKER_HOST=ssh://netcup1 docker image ls tiefenlicht   # verfügbare Tags
echo 'image = "tiefenlicht:<alter-tag>"' > terraform/image.auto.tfvars
task deploy
```

## Troubleshooting

- **`docker version` zeigt keinen Server / Build hängt:** SSH-Zugang zu `netcup1`
  prüfen (`ssh netcup1 true`).
- **SSH-Verbindungsflut / „too many authentication failures" beim Build:**
  sicherstellen, dass `DOCKER_BUILDKIT=0` greift (setzt `release.sh` selbst). Nicht
  auf buildx umstellen. Das Dockerfile darf deshalb keine BuildKit-only-Features
  (`RUN --mount`, Heredocs) nutzen.
- **`ERROR: terraform/image.auto.tfvars fehlt`:** zuerst `task release` laufen
  lassen — `plan`/`deploy` verlangen den Tag aus dieser (gitignoreten) Datei.
- **Tunnel-Socket bleibt liegen** (`/tmp/tl-docker*.sock` oder `tl-docker-tunnel*.sock`
  im Repo): Reste einer abgebrochenen Session; löschen und erneut ausführen.
- **WebSocket verbindet nicht (401):** Die Seite wird unter einem anderen Hostnamen
  aufgerufen als `ALLOWED_ORIGINS` bzw. der Host-Header erlaubt.
- **State-Lock in Terraform:** eine parallele/abgebrochene Apply-Session hält den
  S3-Lock. Erst prüfen, ob wirklich nichts läuft, dann ggf. `terraform force-unlock`.
