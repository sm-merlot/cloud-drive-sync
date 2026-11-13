#!/usr/bin/env bash
# Runs the core integration tests against a real `rclone serve s3` on a temp
# dir. Used by CI (Test workflow) and runnable locally: scripts/integration-s3.sh
set -euo pipefail

# Keep near production. v1.68.x returned URL-encoded keys in ListObjectsV2
# ("with+space.md"), which breaks every name with a space or non-ASCII char.
RCLONE_VERSION="v1.76.0"
PORT="${CDS_IT_PORT:-18080}"
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
root="$work/root"
mkdir -p "$root"
cleanup() { [[ -n "${pid:-}" ]] && kill "$pid" 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT

if command -v rclone >/dev/null 2>&1; then
	rclone=rclone
else
	case "$(uname -m)" in
		x86_64) arch=amd64 ;;
		aarch64 | arm64) arch=arm64 ;;
		*) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
	esac
	name="rclone-${RCLONE_VERSION}-linux-${arch}"
	curl -fsSL -o "$work/rclone.zip" "https://downloads.rclone.org/${RCLONE_VERSION}/${name}.zip"
	python3 -m zipfile -e "$work/rclone.zip" "$work"
	rclone="$work/$name/rclone"
	chmod +x "$rclone"
fi
"$rclone" version | head -1

# Throwaway credentials, localhost only
"$rclone" serve s3 --auth-key "it-access,it-secret" --addr "127.0.0.1:${PORT}" "$root" \
	>"$work/rclone.log" 2>&1 &
pid=$!
for _ in $(seq 1 50); do
	curl -s -o /dev/null "http://127.0.0.1:${PORT}/" && break
	sleep 0.2
done

cd "$here/packages/core"
status=0
CDS_IT_S3_ENDPOINT="http://127.0.0.1:${PORT}" CDS_IT_S3_ROOT="$root" \
	npx vitest run tests/integration || status=$?
if [[ $status -ne 0 ]]; then
	echo "--- rclone log (tail) ---"
	tail -50 "$work/rclone.log"
fi
exit $status
