#!/bin/sh
# Runs inside the built hub image as its default user, with the hardening of compose.yaml and no
# network, e.g.:
#   docker run --rm -i --read-only --network none --cap-drop ALL --security-opt no-new-privileges:true \
#     --tmpfs /tmp --entrypoint sh lawoss-hub:test -s < hub/test/image-smoke.sh
set -eu
fail() { echo "image-smoke: $*" >&2; exit 1; }

[ "$(id -un)" = node ] || fail "not running as node"
for tool in npm npx corepack yarn; do
  ! command -v "$tool" > /dev/null || fail "$tool is present"
done
[ ! -e /usr/local/lib/node_modules/npm ] || fail "npm is present beside node"
# Runtimes and cache are root-owned and not group- or world-writable (the read-only root
# filesystem alone would hide wrong ownership). Symbolic links (node_modules/.bin) are skipped.
wrong=$(find /opt/lawoss ! -type l \( ! -user root -o -perm /022 \) -print | head -n 1)
[ -z "$wrong" ] || fail "not root-owned read-only: $wrong"

# Every runtime finds its warmed cache; a bundled and a non-bundled one list their tools offline.
# Writable HOME and TMPDIR as the pool gives them.
export HOME=/tmp/home TMPDIR=/tmp/home LAWOSS_STATE_DIR=/tmp/state
mkdir -p "$HOME"
for launcher in /opt/lawoss/runtimes/*/scripts/run.mjs; do
  node "$launcher" doctor | grep -q '"cached":true' || fail "not cached: $launcher"
done
node /opt/lawoss/runtimes/crz/scripts/run.mjs tools > /dev/null || fail "crz tools"
node /opt/lawoss/runtimes/judikaty/scripts/run.mjs tools > /dev/null || fail "judikaty tools"

# The entry point verifies all runtimes, starts and answers its healthcheck (placeholder secrets).
HUB_CONFIG_JSON=$(node -e "
  const ids = Object.keys(require('/app/services.json').services);
  const secret = id => (id + '-placeholder-secret-').padEnd(40, 'x');
  console.log(JSON.stringify({ base: 'example.test', issuer: 'https://auth.example.test', services: ids,
    secrets: Object.fromEntries(ids.map(id => [id, secret(id)])) }));")
export HUB_CONFIG_JSON
LAWOSS_DATA_DIR=/tmp/data node /app/dist/main.js > /tmp/hub.log 2>&1 &
hub=$!
ok=1
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if node -e "require('http').get({host:'127.0.0.1',port:3000,path:'/health',timeout:2000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"; then ok=0; break; fi
  sleep 1
done
kill "$hub" 2> /dev/null || true
[ "$ok" = 0 ] || { cat /tmp/hub.log >&2; fail "the hub did not become healthy"; }
echo "image-smoke: ok"
