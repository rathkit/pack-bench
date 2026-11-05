# Rathkit Pack benchmarks

**Report problems with the benchmarks as an issue in [rathkit/pack](https://github.com/rathkit/pack) (label `benchmarks`).**
Issues and pull requests are turned off in this repository, and outside pull requests are not taken.

This repository holds the benchmark runner for [Rathkit Pack](https://github.com/rathkit/pack), the tools Pack is compared
with at pinned versions, and a container recipe that runs everything in isolation, so a published figure can be checked by
anyone. The published figures live in Pack's [`docs/benchmarks.md`](https://github.com/rathkit/pack/blob/main/docs/benchmarks.md),
each with the machine, the load, the tool versions and the commits of both repositories.

Names of other tools appear only to identify them. Measured, on one machine. Other machines, versions and inputs give other
numbers. Nothing here is a claim about inputs that were not measured, and a better configuration of any tool may do better.

## Why a container

The compared tools are third-party code with native binaries. A run happens only in a throwaway container: the base image is
pinned by digest, the packages are installed from the lockfile only with no install scripts, and the run has no network,
a read-only root, a read-only Pack binary, all capabilities dropped, a non-root user, and one writable results folder. A
container on Docker Desktop (WSL2) is isolation, not a security boundary against a determined attacker. Never run the
benchmark, or `pnpm install`, outside it.

## Method

- **What is timed:** the whole command from start to exit, start-up included (`/usr/bin/time`), after one warm-up run; the
  median of 7 runs is shown. Peak memory is the largest resident set of one process (`%M`).
- **What is compared:** the same entry, producing one ES module file for Node, with `process.env.NODE_ENV` defined as
  `"production"` in every tool (`--env none` leaves it out), in three modes: plain, minified, and minified with a source map.
- **Do the outputs work:** each output that can run is run, and what it prints is compared with the first tool's output
  (`same` / `fails` / `DIFFERENT`). three.js needs a browser and lodash-es prints nothing, so they are timed but not run.
- **Parcel:** both versions build from the `targets` in `package.json` (Node, ES module, `node_modules` included). Parcel 2 is
  run with `--no-cache`. Parcel 3 is run as its native executable. Without `--optimize` Parcel neither minifies nor scope-hoists.
- **Other tools** use the options in `run.mjs` (for rspack, a config with `builtin:swc-loader` for TypeScript; for Vite,
  library mode), not tuned beyond that.
- **Launch:** every tool is started through its own entry point, never through the package manager's shell shim in
  `node_modules/.bin` (which would add a shell and a Node start-up to its time): esbuild and Parcel 3 as their native
  executables, and rolldown, rspack, Vite and Parcel 2 as `node <the package's bin file>`, so those four include Node's own
  start-up. `launch` in the results records this (`direct`; `shim` is the older method).
- **Cold:** every run is one fresh container (`--rm`), so no tool keeps a cache from one run to the next. The operating
  system's page cache is warm, because the single warm-up run is part of the method. Outputs go to a RAM disk, so disk speed is out of the timing for every tool alike.
- **Workloads:** the TypeScript 5.9 compiler, three.js, lodash-es (`export *`), React with react-dom/server, an rxjs pipeline,
  and two generated apps (1,500 JavaScript modules and 500 TypeScript modules, `generate.mjs`, deterministic).

## Caveats

- One machine. Docker Desktop's engine runs in the same WSL2 virtual machine as the distribution; `--cpuset-cpus` pins to the
  VM's virtual CPUs, which Hyper-V can still move across physical cores. Load on the Windows side is invisible inside the VM.
  The default cpuset is `2-9` (8 logical CPUs) and stays fixed across published runs; multithreaded tools behave differently
  with fewer CPUs.
- The overlay file system, the tmpfs outputs and the seccomp filter move times a little against a run on the host. Do not mix
  figures from host runs and container runs in one table.
- Parcel 3 is an alpha. Sizes depend on the entry point a tool picks (rxjs has an ES and a CommonJS build).
- **Numbers from CI are smoke tests only.** Shared runners are noisy; they show that the recipe works, never a figure to publish.

## Run it

You need Docker (or Podman) and a Pack binary built for glibc 2.41 or older.

```sh
# 1. Build Pack from a commit, offline, in a pinned Rust image. WORK_DIR must be a folder the engine can see.
container/build-pack.sh ../pack <commit> <out-dir> <work-dir>

# 2. Run. Everything after -- goes to run.mjs.
HOST_NOTE="WSL2, Docker Desktop 29.9.2, laptop on AC" \
  container/run.sh --pack-bin <out-dir>/rkp -- --tools rathkit,esbuild,rolldown,rspack,vite,parcel2,parcel3 --markdown
```

`run.mjs` options: `--runs N`, `--tools`, `--env`, `--modes`, `--markdown`, `--work DIR`, `--results FILE`, `--list-tools`, and
workload names (`ts5 three lodash react rxjs app1500 tsapp500`). Results go to `results/<stamp>.json`.

`CONTAINER=podman` works with the same flags (rootless: `--userns=keep-id`). If Podman refuses `--cpuset-cpus`, remove that flag from
`container/run.sh` in your copy and say so in `HOST_NOTE`. `CPUSET` sets the CPUs (default `2-9`); `HOST_NOTE` goes into the results.

### A publishable run

`container/run.sh --publish` refuses unless the working tree is clean, `--runs` is 7 or more, the Pack binary came from
`container/build-pack.sh` (its `COMMIT` file sits beside it), and the 1-minute load is below 1.0. Before it: AC power, the
Windows power plan on best performance, other apps closed. It also pins the Debian package snapshot date. Commit the results
file to `published/` as `YYYY-MM-DD-<pack sha>-<bench sha>.json`, then:

```sh
node tools/check-results.mjs published/<file>.json
node tools/report.mjs published/<file>.json --into ../pack/docs/benchmarks.md
```

### Reproduce a published figure

Check out the bench commit named in the figure, build Pack at the commit it names, and run with the same `--tools` and the same
`CPUSET`. Output sizes are deterministic and must match cell for cell; times should keep their order.

## Results schema (`schema: 2`)

`date`, `pack.{version,sha256,commit}`, `bench.{commit,imageId,launch,rootfs}`, `node`, `tools.{esbuild,rolldown,rspack,vite,parcel2,parcel3}`,
`machine.{cpu,logicalCpus,cpuset,memoryLimit,kernel,note}`, `load.{before,after}` (`/proc/loadavg`), `env`, `runs`, `modes`, `argv`, `rows`.
`tools/check-results.mjs` fails on any missing field, on fewer than 7 runs, or on a `bench.commit` that is not on `origin/main`.

## Bumping a version or a digest

A version or digest changes the benchmark, so it comes with a full rerun. Edit `package.json`, then prune the lockfile in a
container (`pnpm install --lockfile-only --ignore-scripts` in a pnpm 12.14.0 image; never on the host). To find a new image
digest: `docker buildx imagetools inspect <image:tag> --format '{{json .Manifest.Digest}}'`. Pnpm itself is the standalone
build, checked against the digest GitHub shows for the release.

## License

Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)). See [CONTRIBUTING.md](CONTRIBUTING.md) for how a change is made.
