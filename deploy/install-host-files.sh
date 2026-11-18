#!/bin/sh
# install-host-files.sh RECORD SHA256 SRC_DIR
#
# Installs a release's host files from a checkout of this repository at the release's commit into
# LAWOSS_ROOT (default /opt/lawoss), run with sudo:
#   1. RECORD (releases/<version>.json) must hash to SHA256, the value pinned in the catalog;
#   2. the auth image named by the record (pinned by digest) must carry a verified build
#      attestation when gh is installed;
#   3. the Node binary is copied out of that image to <root>/node/bin/node (no Node package is
#      needed on the host; bin/lawoss-selfhost runs the CLI with it);
#   4. deploy/install-host-files.mjs, run with that Node, checks every source file against the
#      record before writing anything, installs them per deploy/host-files.mjs and checks again.
# Nothing is downloaded except the auth image. Exit codes: 0 success, 1 failure, 2 usage error.
set -eu
umask 022

usage() {
  echo "usage: install-host-files.sh RECORD SHA256 SRC_DIR" >&2
  exit 2
}
fail() {
  echo "install-host-files: $*" >&2
  exit 1
}

[ "$#" -eq 3 ] || usage
record=$1
pinned=$2
src=$3
case $pinned in
  *[!0-9a-f]* | '') usage ;;
esac
[ "${#pinned}" -eq 64 ] || usage
[ -f "$record" ] || fail "RECORD must be a file"
[ -d "$src" ] || fail "SRC_DIR must be a directory"
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
root=${LAWOSS_ROOT:-/opt/lawoss}

digest() {
  if command -v sha256sum > /dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d ' ' -f 1
}
[ "$(digest "$record")" = "$pinned" ] || fail "release record digest does not match the pinned value; nothing was installed"

# The record as the release workflow writes it: one "auth" line, inside "images".
image=$(sed -n 's/^ *"auth": *"\([^"]*\)",\{0,1\} *$/\1/p' "$record")
[ "$(printf '%s\n' "$image" | wc -l | tr -d ' ')" -eq 1 ] || fail "release record must name one auth image"
printf '%s\n' "$image" | grep -Eq '^[a-z0-9][a-z0-9._/:-]{0,254}@sha256:[0-9a-f]{64}$' ||
  fail "release record auth image is not pinned by digest"

if command -v gh > /dev/null 2>&1; then
  gh attestation verify "oci://$image" --repo Omni-Legal-Products/lawoss-selfhost > /dev/null 2>&1 ||
    fail "build attestation of the auth image did not verify; gh must be logged in as root (sudo gh auth login)"
else
  echo "install-host-files: notice: gh is not installed, so the auth image's build attestation was not verified; it is still pinned by digest" >&2
fi

mkdir -p "$root/node/bin"
chmod 755 "$root" "$root/node" "$root/node/bin"
container=$(docker create "$image") || fail "the auth image could not be created"
trap 'docker rm "$container" > /dev/null 2>&1 || true' EXIT
docker cp "$container:/usr/local/bin/node" "$root/node/bin/.node.new" > /dev/null || fail "the Node binary could not be copied from the auth image"
docker rm "$container" > /dev/null || true
trap - EXIT
chmod 755 "$root/node/bin/.node.new"
"$root/node/bin/.node.new" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 14) ? 0 : 1)' ||
  fail "the Node binary of the auth image does not run or is older than 22.14"
mv -f "$root/node/bin/.node.new" "$root/node/bin/node"

"$root/node/bin/node" "$here/install-host-files.mjs" "$record" "$src" "$root"
echo "$root/node/bin/node"
