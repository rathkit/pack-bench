// Compares bundlers on the same inputs: wall time of the whole command (start-up included), peak memory, output
// size, and whether the output runs and prints the same thing.
//
//   container/run.sh --pack-bin PATH -- [options] [workload...]     (the only way a published figure is made)
//
//   --runs N          timed runs per case, after one warm-up run (default 7)
//   --tools a,b,c     rathkit, esbuild, rolldown, rspack, vite, webpack, rollup, parcel2, parcel3 (default rathkit; the others are for development only)
//   --env production  define process.env.NODE_ENV as "production" in every tool (the default), or `none` for no define
//   --modes a,b       plain, minify, minify+map (default all three)
//   --markdown        also print the tables as Markdown
//   --work DIR        where outputs and tool configs are written (default: next to this file); the container gives it a tmpfs
//   --results FILE    where results.json is written (default: results.json next to this file)
//   --list-tools      print each tool's version and executable, then exit
//
// RATHKIT_PACK_BIN names the rathkit-pack binary (default ../target/release/rkp).
// PACK_COMMIT, BENCH_COMMIT, IMAGE_ID and HOST_NOTE (set by container/run.sh) go into results.json.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync, renameSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { here, RK, workloads, createTools, toolVersions, toolExecutables } from './lib.mjs';
import { measureRebuild } from './rebuild.mjs';
import { measureDev, devTools, noDevServer } from './dev.mjs';
import { measureCheck, measureTsc, setups } from './typecheck.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const [, value] = args.splice(at, 2);
  return value;
};
const runs = Number(option('--runs', 7));
const env = option('--env', 'production');
const workDir = option('--work', here);
const resultsFile = option('--results', join(here, 'results.json'));
const listTools = args.includes('--list-tools') && args.splice(args.indexOf('--list-tools'), 1).length > 0;
const markdown = args.includes('--markdown') && args.splice(args.indexOf('--markdown'), 1).length > 0;
const allModes = { plain: { minify: false, map: false }, minify: { minify: true, map: false }, 'minify+map': { minify: true, map: true } };
const modeNames = option('--modes', Object.keys(allModes).join(',')).split(',');
const production = env === 'production';
const flag = (name) => args.includes(name) && args.splice(args.indexOf(name), 1).length > 0;
// Other measurements, each switched on by a flag: --rebuild (warm rebuild in the tool's watch mode), --dev (server start and HMR latency),
// --typecheck (build plus type check, TypeScript workloads only). --no-build leaves out the build table (for developing the others).
const doRebuild = flag('--rebuild');
const doDev = flag('--dev');
const doCheck = flag('--typecheck');
const noBuild = flag('--no-build');
const edits = Number(option('--edits', 7));
const rebuildModes = option('--rebuild-modes', 'plain,minify').split(',');
// How each tool is started: 'direct' is the tool's own entry point (esbuild's and Parcel 3's native executables; `node <the package's bin file>` for the
// Node tools), never the package manager's shell shim in node_modules/.bin, which would add a shell and a Node start-up to the time. Recorded in results.json.
const launch = 'direct';

const tools = createTools({ production });
const selected = option('--tools', 'rathkit').split(',');
if (listTools) {
  const versions = toolVersions();
  const executables = toolExecutables();
  for (const [tool, version] of Object.entries(versions)) {
    // Packages that are not started on their own (a checker plugin, a dev server) have no executable to check.
    if (executables[tool] && !existsSync(executables[tool])) throw new Error(`${tool}: no executable at ${executables[tool]}`);
    console.log(`${tool.padEnd(8)} ${version}  ${executables[tool] ?? ''}`.trimEnd());
  }
  console.log(`node     ${process.version}`);
  process.exit(0);
}
// What is left after the options are the workloads to run (all of them when none are named).
const only = args.filter((a) => !a.startsWith('--'));

mkdirSync(workDir, { recursive: true });
if (process.env.HOME) mkdirSync(process.env.HOME, { recursive: true });

for (const need of [existsSync(RK) ? null : `the rathkit-pack binary (cargo build --release, or RATHKIT_PACK_BIN): ${RK}`, existsSync(join(here, 'node_modules')) ? null : 'pnpm install', existsSync(join(here, 'inputs/generated')) ? null : 'node generate.mjs']) {
  if (need) {
    console.error(`missing: ${need}`);
    process.exit(2);
  }
}

const run = (spec, cwd) => {
  const t = process.hrtime.bigint();
  const r = spawnSync('/usr/bin/time', ['-f', '%M', '--', spec.cmd, ...spec.args], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  return { ms, rss: Number((r.stderr.trim().split('\n').pop() ?? '').trim()), ok: r.status === 0, err: r.stderr };
};
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const sizeOf = (dir) => {
  const files = readdirSync(dir).filter((f) => /\.m?js$/.test(f));
  const big = files.map((f) => join(dir, f)).sort((a, b) => statSync(b).size - statSync(a).size)[0];
  const data = readFileSync(big);
  return { bytes: data.length, gzip: gzipSync(data).length };
};

const readFirst = (file) => {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
};
const readLoad = () => (readFirst('/proc/loadavg') ?? '').split(' ').slice(0, 3).map(Number);
// Everything a published figure has to say about where and how it was made (checked by tools/check-results.mjs).
const metadata = () => {
  const rk = existsSync(RK) ? { version: spawnSync(RK, ['--version'], { encoding: 'utf8' }).stdout.trim(), sha256: createHash('sha256').update(readFileSync(RK)).digest('hex') } : { version: null, sha256: null };
  const mounts = readFirst('/proc/self/mountinfo') ?? '';
  const rootLine = mounts.split('\n').map((l) => l.split(' ')).find((f) => f[4] === '/');
  const cpu = (readFirst('/proc/cpuinfo') ?? '').split('\n').find((l) => l.startsWith('model name'));
  return {
    date: new Date().toISOString(),
    pack: { ...rk, commit: process.env.PACK_COMMIT ?? null },
    bench: { commit: process.env.BENCH_COMMIT ?? null, imageId: process.env.IMAGE_ID ?? null, launch, rootfs: rootLine && rootLine[5].split(',').includes('ro') ? 'read-only' : 'writable-layer' },
    node: process.version,
    tools: toolVersions(),
    machine: {
      cpu: cpu ? cpu.split(':')[1].trim() : null,
      logicalCpus: os.availableParallelism(),
      cpuset: readFirst('/sys/fs/cgroup/cpuset.cpus.effective'),
      memoryLimit: readFirst('/sys/fs/cgroup/memory.max'),
      kernel: os.release(),
      note: process.env.HOST_NOTE ?? '',
    },
  };
};
const loadBefore = readLoad();

const rows = [], rebuild = [], dev = [], typecheck = [];
const save = () => {
  mkdirSync(dirname(resultsFile), { recursive: true });
  const extra = { ...(doRebuild ? { rebuild, rebuildModes, edits } : {}), ...(doDev ? { dev, devNotes: noDevServer, devSkipped: Object.fromEntries(Object.entries(workloads).filter(([n, m]) => !m.web && (!only.length || only.includes(n))).map(([n, m]) => [n, m.webNote ?? 'not served to a browser'])) } : {}), ...(doCheck ? { typecheck } : {}) };
  writeFileSync(resultsFile, JSON.stringify({ schema: 3, ...metadata(), load: { before: loadBefore, after: readLoad() }, env, runs, modes: modeNames, argv: process.argv.slice(2), rows, ...extra }, null, 1));
};
const fmt = (r) => (r.failed ? `FAILED ${r.failed}` : `med ${r.med?.toFixed(1)} ms  min ${r.min?.toFixed(1)} ms  rss ${r.rss?.toFixed(0)} MB`);
for (const [name, meta] of Object.entries(workloads)) {
  const entry = meta.entry;
  if (only.length && !only.includes(name)) continue;
  for (const mode of noBuild ? [] : modeNames) {
    const { minify, map } = allModes[mode];
    let reference = null;
    for (const tool of selected) {
      const dir = join(workDir, 'out', `${name}-${mode}-${tool}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const out = join(dir, 'out.mjs');
      const spec = tools[tool]({ entry, out, minify, map, dir, meta });
      const times = [], rss = [];
      let failed = null;
      for (let i = -1; i < runs; i++) {
        rmSync(out, { force: true });
        if (spec.produced) rmSync(spec.produced, { force: true });
        const r = run(spec, here);
        if (!r.ok) {
          failed = r.err.trim().split('\n').slice(-2).join(' | ').slice(0, 160);
          break;
        }
        if (i >= 0) {
          times.push(r.ms);
          rss.push(r.rss);
        }
      }
      if (!failed && spec.produced) {
        if (existsSync(spec.produced)) renameSync(spec.produced, out);
        else failed = `no output at ${spec.produced}`;
      }
      let runs_ = '-';
      if (!failed && meta.run) {
        const r = spawnSync(process.execPath, [out], { encoding: 'utf8', timeout: 60000 });
        const printed = r.status === 0 ? r.stdout : null;
        if (printed !== null && printed.trim() !== '' && reference === null) reference = printed;
        // A program that prints nothing, where the others print something, does not count as having worked.
        runs_ = printed === null || printed.trim() === '' ? 'fails' : printed === reference ? 'same' : 'DIFFERENT';
      }
      const size = failed ? null : sizeOf(dir);
      const row = { name, mode, tool, min: failed ? null : Math.min(...times), med: failed ? null : median(times), rss: failed ? null : Math.max(...rss) / 1024, size, runs: runs_, failed };
      rows.push(row);
      console.log(`${name.padEnd(9)} ${mode.padEnd(10)} ${tool.padEnd(8)} ${failed ? 'FAILED ' + failed : `med ${row.med.toFixed(0).padStart(5)} ms  min ${row.min.toFixed(0).padStart(5)} ms  rss ${row.rss.toFixed(0).padStart(4)} MB  out ${(size.bytes / 1024).toFixed(0).padStart(6)} KB  gz ${(size.gzip / 1024).toFixed(0).padStart(5)} KB  runs ${runs_}`}`);
    }
  }
  save();
  if (doRebuild) {
    for (const mode of rebuildModes) {
      for (const tool of selected) {
        const r = await measureRebuild({ tool, name, meta, mode, tools, workDir, edits }).catch((e) => ({ start: null, times: [], rss: null, failed: `harness: ${e.message}` }));
        rebuild.push({ name, mode, tool, ...r });
        console.log(`${name.padEnd(9)} rebuild ${mode.padEnd(7)} ${tool.padEnd(8)} ${r.unsupported ? 'n/a: ' + r.unsupported : r.failed && !r.times.length ? 'FAILED ' + r.failed : `first build ${r.start?.toFixed(0)} ms, rebuild ${fmt(r)}${r.failed ? ` (${r.failed})` : ''}`}`);
        save();
      }
    }
  }
  if (doDev && meta.web) {
    for (const tool of selected) {
      if (!devTools[tool]) continue;
      const r = await measureDev({ tool, name, meta, workDir, runs, edits }).catch((e) => ({ start: [], hmr: [], failed: `harness: ${e.message}` }));
      dev.push({ name, tool, ...r });
      console.log(`${name.padEnd(9)} dev     ${tool.padEnd(8)} ${r.failed ? 'FAILED ' + r.failed : `start med ${r.startMed?.toFixed(0)} ms (${r.files} files), hmr med ${r.hmrMed?.toFixed(1) ?? '-'} ms ${r.hmrType ?? ''}${r.hmrFailed ? ` (${r.hmrFailed})` : ''}, rss ${r.rss?.toFixed(0)} MB`}`);
      save();
    }
  }
  if (doCheck && meta.ts) {
    const base = await measureTsc({ name, meta, runs });
    typecheck.push(base);
    console.log(`${name.padEnd(9)} check   tsc      ${base.withCheck.failed ?? fmt(base.withCheck)}`);
    for (const tool of selected) {
      if (!setups[tool]) continue;
      const r = await measureCheck({ tool, name, meta, tools, workDir, runs }).catch((e) => ({ name, tool, failed: `harness: ${e.message}`, buildOnly: {}, withCheck: {} }));
      typecheck.push(r);
      console.log(`${name.padEnd(9)} check   ${tool.padEnd(8)} ${r.failed ?? `build ${fmt(r.buildOnly)} | with check ${fmt(r.withCheck)}`}`);
      save();
    }
  }
}
save();

// ---- tables ----
const names = Object.keys(workloads).filter((w) => rows.some((r) => r.name === w));
const get = (w, m, t) => rows.find((r) => r.name === w && r.mode === m && r.tool === t);
const table = (title, cell, unit) => {
  const out = [];
  out.push(markdown ? `\n#### ${title}\n` : `\n== ${title}`);
  const head = ['', ...selected];
  out.push(markdown ? `| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|` : head.map((h, i) => (i ? h.padStart(10) : h.padEnd(10))).join(''));
  for (const w of names) {
    const cells = selected.map((t) => {
      const r = get(w, cell.mode, t);
      return !r || r.failed ? 'failed' : cell.of(r);
    });
    out.push(markdown ? `| ${[w, ...cells].join(' | ')} |` : [w.padEnd(10), ...cells.map((c) => c.padStart(10))].join(''));
  }
  return out.join('\n');
};
for (const mode of modeNames) {
  console.log(table(`${mode}: median ms (${env})`, { mode, of: (r) => r.med.toFixed(0) }));
  if (selected.includes('rathkit')) {
    const lines = selected
      .filter((t) => t !== 'rathkit')
      .map((t) => {
        const ratios = names.map((w) => [get(w, mode, t), get(w, mode, 'rathkit')]).filter(([a, b]) => a && b && !a.failed && !b.failed).map(([a, b]) => a.med / b.med);
        return `${t} ${(Math.exp(ratios.reduce((s, x) => s + Math.log(x), 0) / ratios.length)).toFixed(2)}x`;
      });
    console.log(`  geometric mean time relative to rathkit: ${lines.join(', ')}`);
  }
}
for (const mode of modeNames.filter((m) => m.startsWith('minify'))) {
  console.log(table(`${mode}: output KB / gzip KB (${env})`, { mode, of: (r) => `${(r.size.bytes / 1024).toFixed(0)}/${(r.size.gzip / 1024).toFixed(0)}` }));
  break;
}
console.log(table(`${modeNames.at(-1)}: peak memory MB`, { mode: modeNames.at(-1), of: (r) => r.rss.toFixed(0) }));
console.log(table(`${modeNames[0]}: does the output run and print the same?`, { mode: modeNames[0], of: (r) => r.runs }));
