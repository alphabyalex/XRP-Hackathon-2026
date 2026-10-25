#!/bin/sh
# Public code only. Runtime credentials arrive through Console secret references.
set -eu
umask 077
case "${MOONSHIFT_REVISION:-}" in
  *[!a-f0-9]*|'') echo 'A full release revision is required'; exit 1 ;;
esac
[ "${#MOONSHIFT_REVISION}" -eq 40 ] || exit 1
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends python3 python3-venv curl ca-certificates
release="/data/releases/$MOONSHIFT_REVISION"
mkdir -p "$release" /data/state /data/logs
if [ ! -f "$release/package-lock.json" ]; then
  curl --fail --location --retry 3 --silent --show-error \
    "https://github.com/alphabyalex/XRP-Hackathon-2026/archive/$MOONSHIFT_REVISION.tar.gz" \
    | tar -xz --strip-components=1 -C "$release"
fi
cd "$release"
if [ ! -f .dependencies-ready ]; then
  npm ci --no-audit --no-fund > /data/logs/npm-install.log 2>&1
  for service in compute pricing risk credit router; do
    python3 -m venv "/data/venvs/$MOONSHIFT_REVISION/$service"
    "/data/venvs/$MOONSHIFT_REVISION/$service/bin/pip" install --disable-pip-version-check \
      -r "services/$service/requirements.txt" > "/data/logs/$service-install.log" 2>&1
  done
  touch .dependencies-ready
fi
if [ "${MOONSHIFT_PREPARE_ONLY:-0}" = "1" ]; then
  echo 'Release dependencies prepared without starting backend services'
  exit 0
fi
exec "/data/venvs/$MOONSHIFT_REVISION/compute/bin/python" infra/akash/backend/run.py
