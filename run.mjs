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
import { join, dirname, basename, extname } from 'node:path';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const RK = process.env.RATHKIT_PACK_BIN ?? join(here, '..', 'target', 'release', 'rkp');

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
// How each tool is started: 'direct' is the tool's own entry point (esbuild's and Parcel 3's native executables; `node <the package's bin file>` for the
// Node tools), never the package manager's shell shim in node_modules/.bin, which would add a shell and a Node start-up to the time. Recorded in results.json.
const launch = 'direct';

const workloads = {
  ts5: 'inputs/ts5.js',
  three: 'inputs/three.js',
  lodash: 'inputs/lodash.js',
  react: 'inputs/react.js',
  rxjs: 'inputs/rxjs.js',
  app1500: 'inputs/generated/app1500/main.js',
  tsapp500: 'inputs/generated/tsapp500/main.ts',
};
// three needs a browser to run; the others print something every tool must agree on.
const runnable = new Set(['ts5', 'react', 'rxjs', 'app1500', 'tsapp500']);
const externals = [...builtinModules, ...builtinModules.map((m) => 'node:' + m)];
const NODE_ENV = '"production"';


const pkgDir = (name) => realpathSync(join(here, 'node_modules', name));
// The file a package's `bin` field names.
const pkgBin = (name, binName) => {
  const dir = pkgDir(name);
  const field = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).bin;
  return join(dir, typeof field === 'string' ? field : field[binName]);
};
// esbuild's native executable, from the platform package that sits next to esbuild (the install script that would link it is not run).
const esbuildBinary = () => createRequire(join(pkgDir('esbuild'), 'package.json')).resolve(`@esbuild/${process.platform}-${process.arch}/bin/${process.platform === 'win32' ? 'esbuild.exe' : 'esbuild'}`);
const pkgVersion = (name) => JSON.parse(readFileSync(join(here, 'node_modules', name, 'package.json'), 'utf8')).version;

// Parcel 3 is a native executable that npm installs as a platform package; the `parcel3` launcher is a Node script that starts it,
// and timing it would add a Node start-up, so the executable is run directly.
const parcel3Binary = () => {
  const need = createRequire(realpathSync(join(here, 'node_modules', 'parcel3', 'package.json')));
  const base = `@parcel/parcel3-${process.platform}-${process.arch}`;
  const exe = process.platform === 'win32' ? 'parcel.exe' : 'parcel';
  for (const pkg of [base, `${base}-gnu`, `${base}-musl`]) {
    try {
      return need.resolve(`${pkg}/${exe}`);
    } catch {}
  }
  throw new Error(`no Parcel 3 executable for ${process.platform} ${process.arch}`);
};
// Both Parcel versions build from the \`targets\` in package.json (a Node ES module, node_modules included), write to the folder of the case,
// and name the file after the entry; the file is renamed to out.mjs afterwards. Parcel 2 is told not to keep its disk cache
// so that every run is a cold build; Parcel 3 has none. Without --optimize Parcel does not minify and does not scope-hoist.
const parcelCase = ({ entry, minify, map, dir }) => ({
  entryPath: join(here, entry),
  flags: ['--dist-dir', dir, '--no-content-hash', '--log-level', 'error', ...(minify ? [] : ['--no-optimize']), ...(map ? [] : ['--no-source-maps'])],
  produced: join(dir, basename(entry, extname(entry)) + '.js'),
});

const tools = {
  rathkit: ({ entry, out, minify, map }) => ({ cmd: RK, args: ['bundle', entry, '--outfile', out, '--no-config', ...(production ? ['--define', `process.env.NODE_ENV=${NODE_ENV}`] : []), ...(minify ? ['--minify'] : []), ...(map ? ['--sourcemap'] : [])] }),
  esbuild: ({ entry, out, minify, map }) => ({ cmd: esbuildBinary(), args: [entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${out}`, '--log-level=error', '--banner:js=import { createRequire as __rkRequire } from "node:module"; import { fileURLToPath as __rkPath } from "node:url"; import { dirname as __rkDir } from "node:path"; const require = __rkRequire(import.meta.url), __filename = __rkPath(import.meta.url), __dirname = __rkDir(__filename);', ...(production ? [`--define:process.env.NODE_ENV=${NODE_ENV}`] : []), ...(minify ? ['--minify'] : []), ...(map ? ['--sourcemap'] : [])] }),
  rolldown: ({ entry, out, minify, map }) => ({ cmd: process.execPath, args: [pkgBin('rolldown', 'rolldown'), entry, '--file', out, '--format', 'esm', '--platform', 'node', ...(production ? ['--transform.define', `process.env.NODE_ENV=${NODE_ENV}`] : []), ...(minify ? ['--minify'] : []), ...(map ? ['--sourcemap'] : [])] }),
  rspack: ({ entry, out, minify, map, dir }) => {
    const config = join(dir, 'rspack.config.mjs');
    writeFileSync(
      config,
      `export default { mode: 'production', context: ${JSON.stringify(here)}, entry: ${JSON.stringify(join(here, entry))}, target: 'node', externalsPresets: { node: true }, devtool: ${map ? "'source-map'" : 'false'}, optimization: { minimize: ${minify}, nodeEnv: ${production ? "'production'" : 'false'} }, experiments: { outputModule: true }, resolve: { extensions: ['.ts', '.js', '.mjs', '.json'] }, module: { rules: [{ test: /\\.ts$/, loader: 'builtin:swc-loader', options: { jsc: { parser: { syntax: 'typescript' } } }, type: 'javascript/auto' }] }, output: { path: ${JSON.stringify(dirname(out))}, filename: ${JSON.stringify(out.split('/').pop())}, module: true, library: { type: 'module' }, chunkFormat: 'module' }, stats: 'errors-only' };\n`,
    );
    return { cmd: process.execPath, args: [pkgBin('@rspack/cli', 'rspack'), 'build', '--config', config] };
  },
  vite: ({ entry, out, minify, map, dir }) => {
    // The values reach the config as data (a JSON file read at run time), never spliced into code.
    const config = join(dir, 'vite.config.mjs');
    const values = join(dir, 'vite.values.json');
    writeFileSync(values, JSON.stringify({ root: here, entry: join(here, entry), outDir: dirname(out), fileName: out.split('/').pop(), minify: minify ? 'oxc' : false, sourcemap: map, define: production ? { 'process.env.NODE_ENV': NODE_ENV } : {}, external: externals }));
    writeFileSync(
      config,
      `import { readFileSync } from 'node:fs';\nconst v = JSON.parse(readFileSync(new URL('./vite.values.json', import.meta.url), 'utf8'));\nexport default { root: v.root, logLevel: 'error', configFile: false, define: v.define, build: { outDir: v.outDir, emptyOutDir: false, minify: v.minify, sourcemap: v.sourcemap, target: 'esnext', lib: { entry: v.entry, formats: ['es'], fileName: () => v.fileName }, rollupOptions: { external: v.external } } };\n`,
    );
    return { cmd: process.execPath, args: [pkgBin('vite', 'vite'), 'build', '--config', config] };
  },
  // webpack: the same options as the rspack case (production mode, minimizing and the NODE_ENV define switched by the case), with swc-loader for
  // TypeScript (type stripping only, no type check) and webpack's own default minimizer (terser).
  webpack: ({ entry, out, minify, map, dir }) => {
    const config = join(dir, 'webpack.config.mjs');
    const loader = createRequire(join(here, 'package.json')).resolve('swc-loader');
    writeFileSync(
      config,
      `export default { mode: 'production', context: ${JSON.stringify(here)}, entry: ${JSON.stringify(join(here, entry))}, target: 'node', externalsPresets: { node: true }, devtool: ${map ? "'source-map'" : 'false'}, optimization: { minimize: ${minify}, nodeEnv: ${production ? "'production'" : 'false'} }, experiments: { outputModule: true }, resolve: { extensions: ['.ts', '.js', '.mjs', '.json'] }, module: { rules: [{ test: /\\.ts$/, loader: ${JSON.stringify(loader)}, options: { jsc: { parser: { syntax: 'typescript' } } } }] }, output: { path: ${JSON.stringify(dirname(out))}, filename: ${JSON.stringify(out.split('/').pop())}, module: true, library: { type: 'module' }, chunkFormat: 'module' }, stats: 'errors-only' };\n`,
    );
    return { cmd: process.execPath, args: [pkgBin('webpack-cli', 'webpack-cli'), 'build', '--config', config] };
  },
  // Rollup: node-resolve and commonjs (it reads neither on its own), replace for the NODE_ENV define, @rollup/plugin-typescript with its type checking
  // off (noCheck) for TypeScript, and @rollup/plugin-terser for the minified cases (Rollup has no minifier of its own). The plugins are loaded
  // from this folder's node_modules, because the config is written to the work folder.
  rollup: ({ entry, out, minify, map, dir }) => {
    const config = join(dir, 'rollup.config.mjs');
    const plugins = [
      production ? `load('@rollup/plugin-replace')({ preventAssignment: true, values: { 'process.env.NODE_ENV': ${JSON.stringify(NODE_ENV)} } })` : null,
      `load('@rollup/plugin-node-resolve')({ preferBuiltins: true, extensions: ['.mjs', '.js', '.json', '.ts'] })`,
      `load('@rollup/plugin-commonjs')()`,
      `load('@rollup/plugin-typescript')({ tsconfig: false, compilerOptions: { noCheck: true, module: 'esnext', target: 'esnext', moduleResolution: 'bundler' } })`,
      minify ? `load('@rollup/plugin-terser')()` : null,
    ].filter(Boolean);
    writeFileSync(
      config,
      `import { createRequire } from 'node:module';\nconst r = createRequire(${JSON.stringify(join(here, 'package.json'))});\nconst load = (name) => { const m = r(name); return m.default ?? m; };\nexport default { input: ${JSON.stringify(join(here, entry))}, external: ${JSON.stringify(externals)}, plugins: [${plugins.join(', ')}], output: { file: ${JSON.stringify(out)}, format: 'es', sourcemap: ${map} }, onwarn() {} };\n`,
    );
    return { cmd: process.execPath, args: [pkgBin('rollup', 'rollup'), '--config', config, '--silent'] };
  },
  parcel2: (c) => {
    const p = parcelCase(c);
    return { cmd: process.execPath, args: [join(here, 'node_modules/parcel2/lib/bin.js'), 'build', p.entryPath, '--no-cache', '--no-autoinstall', ...p.flags], produced: p.produced };
  },
  parcel3: (c) => {
    const p = parcelCase(c);
    return { cmd: parcel3Binary(), args: ['build', p.entryPath, ...p.flags], produced: p.produced };
  },
};
const selected = option('--tools', 'rathkit').split(',');
const toolVersions = () => ({
  esbuild: pkgVersion('esbuild'),
  rolldown: pkgVersion('rolldown'),
  rspack: `${pkgVersion('@rspack/core')} (cli ${pkgVersion('@rspack/cli')})`,
  vite: pkgVersion('vite'),
  webpack: `${pkgVersion('webpack')} (webpack-cli ${pkgVersion('webpack-cli')}, swc-loader ${pkgVersion('swc-loader')}, @swc/core ${pkgVersion('@swc/core')})`,
  rollup: `${pkgVersion('rollup')} (node-resolve ${pkgVersion('@rollup/plugin-node-resolve')}, commonjs ${pkgVersion('@rollup/plugin-commonjs')}, replace ${pkgVersion('@rollup/plugin-replace')}, typescript ${pkgVersion('@rollup/plugin-typescript')}, terser ${pkgVersion('@rollup/plugin-terser')})`,
  parcel2: pkgVersion('parcel2'),
  parcel3: pkgVersion('parcel3'),
});
if (listTools) {
  const versions = toolVersions();
  const executables = { esbuild: esbuildBinary(), rolldown: pkgBin('rolldown', 'rolldown'), rspack: pkgBin('@rspack/cli', 'rspack'), vite: pkgBin('vite', 'vite'), webpack: pkgBin('webpack-cli', 'webpack-cli'), rollup: pkgBin('rollup', 'rollup'), parcel2: join(here, 'node_modules/parcel2/lib/bin.js'), parcel3: parcel3Binary() };
  for (const [tool, version] of Object.entries(versions)) {
    if (!existsSync(executables[tool])) throw new Error(`${tool}: no executable at ${executables[tool]}`);
    console.log(`${tool.padEnd(8)} ${version}  ${executables[tool]}`);
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

const rows = [];
for (const [name, entry] of Object.entries(workloads)) {
  if (only.length && !only.includes(name)) continue;
  for (const mode of modeNames) {
    const { minify, map } = allModes[mode];
    let reference = null;
    for (const tool of selected) {
      const dir = join(workDir, 'out', `${name}-${mode}-${tool}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const out = join(dir, 'out.mjs');
      const spec = tools[tool]({ entry, out, minify, map, dir });
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
      if (!failed && runnable.has(name)) {
        const r = spawnSync(process.execPath, [out], { encoding: 'utf8', timeout: 60000 });
        const printed = r.status === 0 ? r.stdout : null;
        if (printed !== null && reference === null) reference = printed;
        runs_ = printed === null ? 'fails' : printed === reference ? 'same' : 'DIFFERENT';
      }
      const size = failed ? null : sizeOf(dir);
      const row = { name, mode, tool, min: failed ? null : Math.min(...times), med: failed ? null : median(times), rss: failed ? null : Math.max(...rss) / 1024, size, runs: runs_, failed };
      rows.push(row);
      console.log(`${name.padEnd(9)} ${mode.padEnd(10)} ${tool.padEnd(8)} ${failed ? 'FAILED ' + failed : `med ${row.med.toFixed(0).padStart(5)} ms  min ${row.min.toFixed(0).padStart(5)} ms  rss ${row.rss.toFixed(0).padStart(4)} MB  out ${(size.bytes / 1024).toFixed(0).padStart(6)} KB  gz ${(size.gzip / 1024).toFixed(0).padStart(5)} KB  runs ${runs_}`}`);
    }
  }
}
const loadAfter = readLoad();
mkdirSync(dirname(resultsFile), { recursive: true });
writeFileSync(resultsFile, JSON.stringify({ schema: 2, ...metadata(), load: { before: loadBefore, after: loadAfter }, env, runs, modes: modeNames, argv: process.argv.slice(2), rows }, null, 1));

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
