#!/bin/sh
# Builds the Pack binary (rkp) from one commit, offline, in a pinned Rust image.
#   container/build-pack.sh PACK_REPO_DIR COMMIT OUT_DIR WORK_DIR
# WORK_DIR is a folder the container engine can see (not mktemp: under WSL2 the Docker Desktop daemon may not see the distro's /tmp).
# Pack has no dependencies, so `cargo build --locked` needs no network. OUT_DIR gets rkp and a COMMIT file, which container/run.sh --publish requires.
# Uses $CONTAINER (docker, the default, or podman).
set -eu
[ "$#" -eq 4 ] || { echo "usage: $0 PACK_REPO_DIR COMMIT OUT_DIR WORK_DIR" >&2; exit 2; }
engine=${CONTAINER:-docker}
repo=$1 commit=$2 out=$3 work=$4
full=$(git -C "$repo" rev-parse --verify "$commit^{commit}")
src="$work/pack-src-$full"
rm -rf "$src" && mkdir -p "$src"
git -C "$repo" archive "$full" | tar -x -C "$src"
mkdir -p "$out"
# rust:1.99.1-trixie, the compiler of the published run
"$engine" run --rm --network none --user "$(id -u):$(id -g)" -e CARGO_HOME=/tmp/cargo \
  -v "$src":/src:ro -v "$out":/out:rw \
  docker.io/library/rust:1.99.1-trixie@sha256:bc2c4c21d4467cdbbac0ee7b95a6deb742a3467dfe0ff7647916c4b42ca56372 \
  sh -c 'cp -r /src /tmp/p && cd /tmp/p && cargo build --release --locked && cp target/release/rkp /out/rkp && /out/rkp --version'
printf '%s\n' "$full" > "$out/COMMIT"
rm -rf "$src"
echo "built rkp from $full into $out"
