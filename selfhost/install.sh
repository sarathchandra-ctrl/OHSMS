#!/usr/bin/env bash
# Installs, or starts again, WEEHS on this server. docs/SELF-HOSTING.md.
#
#   ./install.sh --domain ehs.example.com --image ghcr.io/OWNER/weehs-dedicated@sha256:DIGEST
#
# First run: writes .env with every random secret generated here, starts the
# database, the app and Caddy, and waits until the app answers. Later runs
# (an upgrade, a reboot, a changed image) keep .env as it is and only start.
#
# It never generates a second set of secrets over an existing .env. A new
# STATE_KEY cannot read what the old one sealed and the app refuses to start;
# new database passwords do not match the database that already exists. Both
# are data loss in the shape of a configuration change.
set -euo pipefail

cd "$(dirname "$0")"

DOMAIN=''
IMAGE=''
ASSUME_YES=0

usage() {
  cat <<'USAGE'
Usage: ./install.sh --domain NAME --image IMAGE [--yes]

  --domain NAME   The address people type, without https:// (ehs.example.com).
                  Its DNS record must point at this server.
  --image IMAGE   The image from the release page, preferably the @sha256 form.
  --yes           Do not ask for confirmation.

Run again with no options to start an existing install.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --image) IMAGE="${2:-}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

# ── What this needs ─────────────────────────────────────────────────────────
command -v docker >/dev/null || die 'Docker is not installed (https://docs.docker.com/engine/install/).'
docker compose version >/dev/null 2>&1 || die 'The Docker Compose plugin is not installed.'
docker info >/dev/null 2>&1 || die 'Docker is installed but not running, or this user may not use it.'
command -v openssl >/dev/null || die 'openssl is not installed.'
command -v curl >/dev/null || die 'curl is not installed.'

# ── Settings ────────────────────────────────────────────────────────────────
if [ -f .env ]; then
  say 'Using the existing .env (its secrets are kept).'
  [ -z "$DOMAIN$IMAGE" ] || echo '    --domain and --image are ignored: edit .env to change them.'
else
  [ -n "$DOMAIN" ] || { usage >&2; die '--domain is required for a first install.'; }
  [ -n "$IMAGE" ] || { usage >&2; die '--image is required for a first install.'; }
  # A bare host name: the app builds every link on https://DOMAIN, and refuses
  # to start on anything that is not an origin.
  case "$DOMAIN" in
    http://*|https://*) die '--domain is the name only, without http:// or https://.' ;;
  esac
  printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' ||
    die "--domain \"$DOMAIN\" is not a host name."
  printf '%s' "$IMAGE" | grep -Eq '^[A-Za-z0-9./_:@-]+$' || die "--image \"$IMAGE\" is not an image reference."

  if [ "$ASSUME_YES" -ne 1 ]; then
    printf '\nInstall WEEHS for https://%s\n  image: %s\nContinue? [y/N] ' "$DOMAIN" "$IMAGE"
    read -r answer
    case "$answer" in y|Y|yes|YES) ;; *) die 'Stopped. Nothing was written.' ;; esac
  fi

  say 'Writing .env with new random secrets'
  # The same commands docs/SELF-HOSTING.md gives. Hex for the database
  # passwords keeps them safe inside a connection URL; DATA_KEY_MASTER and
  # STATE_KEY are 32 bytes of base64, the only form the app accepts.
  umask 077
  cp .env.example .env.tmp
  set_env() {
    # Every value here is hex, base64 or a checked name/image: none contains |.
    sed -i.bak "s|^$1=.*|$1=$2|" .env.tmp && rm -f .env.tmp.bak
  }
  set_env WEEHS_IMAGE "$IMAGE"
  set_env DOMAIN "$DOMAIN"
  set_env DB_ADMIN_PASSWORD "$(openssl rand -hex 24)"
  set_env APP_DB_PASSWORD "$(openssl rand -hex 24)"
  set_env STATE_KEY "$(openssl rand -base64 32)"
  set_env CONTROL_TOKEN "$(openssl rand -hex 32)"
  set_env SESSION_SECRET "$(openssl rand -hex 32)"
  set_env DATA_KEY_MASTER "$(openssl rand -base64 32)"
  chmod 600 .env.tmp
  mv .env.tmp .env
  echo '    .env written (readable by this user only).'
  echo '    Back it up somewhere off this server now: without STATE_KEY the'
  echo '    app cannot start, and without the passwords the data cannot be reached.'
fi

DOMAIN="$(grep -E '^DOMAIN=' .env | cut -d= -f2-)"
[ -n "$DOMAIN" ] || die 'DOMAIN is empty in .env.'

# ── Start ───────────────────────────────────────────────────────────────────
PROFILES="$(grep -E '^COMPOSE_PROFILES=' .env | cut -d= -f2-)"
PROFILES="${PROFILES:-caddy}"
say "Starting the database, the app and the front door: $PROFILES (docker compose up -d)"
COMPOSE_PROFILES="$PROFILES" docker compose up -d

say "Waiting for https://$DOMAIN/health"
# With caddy this is asked of Caddy on this machine, so it works before DNS
# has spread and past any outbound proxy the server is configured with. -k
# because this checks that the app answers, not the certificate. With the
# Cloudflare Tunnel it goes through Cloudflare, the way people will.
health() {
  case "$PROFILES" in
    *cloudflare*) curl -fs --max-time 5 "https://$DOMAIN/health" ;;
    *) curl -fsk --max-time 5 --noproxy "$DOMAIN" --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/health" ;;
  esac
}
ok=0
for _ in $(seq 1 90); do
  if health 2>/dev/null | grep -q '"ok":true'; then
    ok=1
    break
  fi
  sleep 2
done

docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'

if [ "$ok" -ne 1 ]; then
  echo
  echo 'The app did not answer within 3 minutes. Its log:'
  docker compose logs --tail 20 app || true
  die "https://$DOMAIN/health is not answering yet."
fi

cat <<NEXT

OHSMS is running at https://$DOMAIN  (health: {"ok":true})

Next, in a browser: open https://$DOMAIN/setup
  Setup code: CONTROL_TOKEN in .env
  Enter your organization and its sign-in (SAML or OpenID Connect), then sign in.
NEXT
