#!/bin/sh
# The only way a benchmark is run: in a throwaway container with no network, a read-only Pack binary and one writable results folder.
#   container/run.sh --pack-bin PATH [--publish] [--] [run.mjs options...]
# PATH is the rkp binary, built by container/build-pack.sh (a COMMIT file beside it names the Pack commit).
# --publish makes a figure that may be published: a clean tree, at least 7 runs, a binary from build-pack.sh, an idle machine,
#   and the Debian package snapshot pinned (SNAPSHOT, default below).
# Environment: CONTAINER (docker or podman), CPUSET (default 2-9), HOST_NOTE (for example "WSL2, Docker Desktop 29.9.2, laptop on AC").
set -eu
engine=${CONTAINER:-docker}
pack_bin= publish=0
while [ "$#" -gt 0 ]; do
  case $1 in
    --pack-bin) pack_bin=$2; shift 2 ;;
    --publish) publish=1; shift ;;
    --) shift; break ;;
    *) break ;;
  esac
done
[ -n "$pack_bin" ] && [ -f "$pack_bin" ] || { echo "run.sh: --pack-bin PATH to an rkp binary is required" >&2; exit 2; }
pack_bin=$(cd "$(dirname "$pack_bin")" && pwd)/$(basename "$pack_bin")
cd "$(dirname "$0")/.."

# The binary must run on the image's glibc (2.41).
need=$(objdump -T "$pack_bin" 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sort -Vu | tail -1 | sed 's/GLIBC_//' || true)
if [ -n "$need" ] && [ "$(printf '%s\n2.41\n' "$need" | sort -V | tail -1)" != "2.41" ]; then
  echo "run.sh: the binary needs glibc $need, the image has 2.41; build it with container/build-pack.sh" >&2; exit 2
fi
pack_commit=$(cat "$(dirname "$pack_bin")/COMMIT" 2>/dev/null || true)
load=$(cut -d' ' -f1 /proc/loadavg)
idle=$(awk -v l="$load" 'BEGIN { print (l < 1.0) ? 1 : 0 }')
snapshot=
if [ "$publish" = 1 ]; then
  [ -z "$(git status --porcelain)" ] || { echo "run.sh --publish: the working tree is not clean" >&2; exit 2; }
  [ -n "$pack_commit" ] || { echo "run.sh --publish: no COMMIT file beside the binary; build it with container/build-pack.sh" >&2; exit 2; }
  runs=7; prev=
  for a in "$@"; do [ "$prev" = --runs ] && runs=$a; prev=$a; done
  [ "$runs" -ge 7 ] || { echo "run.sh --publish: --runs must be 7 or more" >&2; exit 2; }
  [ "$idle" = 1 ] || { echo "run.sh --publish: the machine is not idle (1-minute load $load, need below 1.0)" >&2; exit 2; }
  snapshot=${SNAPSHOT:-20261105T000000Z}
elif [ "$idle" != 1 ]; then
  echo "run.sh: warning: the machine is not idle (1-minute load $load); do not publish this run" >&2
fi

bench_commit=$(git rev-parse HEAD)
dirty=; [ -z "$(git status --porcelain)" ] || dirty=-dirty
image=pack-bench:$bench_commit$dirty
"$engine" build --build-arg BENCH_COMMIT="$bench_commit$dirty" --build-arg SNAPSHOT="$snapshot" -t "$image" -f container/Containerfile .
image_id=$("$engine" image inspect --format '{{.Id}}' "$image")
mkdir -p results
stamp=$(date -u +%Y%m%dT%H%M%SZ)
# Same cpuset and memory for every tool in a run. No --cpus (a CFS quota throttles multithreaded tools unevenly).
# The root file system is read-only. Parcel 2 makes /bench/.parcel-cache even with --no-cache, so that one path is a small tmpfs
# (nothing is kept between runs, and no tool option changes). If another tool must write under /bench, remove --read-only instead
# (the writable layer goes away with --rm); results.json records which one was used.
user="$(id -u):$(id -g)"
[ "$engine" != podman ] || user=0:0
"$engine" run --rm \
  --network none \
  --read-only --tmpfs /work:rw,exec,size=6g --tmpfs /tmp:rw,exec,size=1g --tmpfs /bench/.parcel-cache:rw,exec,size=512m,mode=1777 \
  --cpuset-cpus "${CPUSET:-2-9}" --memory 12g --memory-swap 12g --pids-limit 4096 \
  --cap-drop ALL --security-opt no-new-privileges \
  $( [ "$engine" = podman ] && echo --userns=keep-id || echo "--user $user" ) -e HOME=/work/home \
  -v "$pack_bin":/opt/rkp/rkp:ro \
  -v "$PWD/results":/results:rw \
  -e RATHKIT_PACK_BIN=/opt/rkp/rkp -e PACK_COMMIT="$pack_commit" -e BENCH_COMMIT="$bench_commit$dirty" \
  -e IMAGE_ID="$image_id" -e HOST_NOTE="${HOST_NOTE:-}" \
  "$image" --work /work --results "/results/$stamp.json" "$@"
echo "results: results/$stamp.json"
