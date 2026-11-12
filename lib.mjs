// What the benchmark scripts share: the workloads, how each tool is started for a build, a watch (rebuild) or a dev server, and the tool versions.
import { writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { createRequire, builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));
export const RK = process.env.RATHKIT_PACK_BIN ?? join(here, '..', 'target', 'release', 'rkp');

// Every workload: its entry; `run` (the output can run under Node, so what it prints is compared); `ts` (TypeScript, so it is type-checked in the
// build-plus-check table); `jsx` (the JSX import source); `edit` (the project file that the rebuild and HMR measurements change); `web` (can be served to a browser,
// that is, it does not need Node's own modules). Names are the keys of results.json rows.
export const workloads = {
  ts5: { entry: 'inputs/ts5.js', run: true, edit: 'inputs/ts5.js', web: false, webNote: 'the TypeScript compiler is a library for Node with no page to serve: it needs fs, path, os and other Node modules, which each tool would have to be set up to stub differently' },
  three: { entry: 'inputs/three.js', run: false, edit: 'inputs/three.js', web: true },
  lodash: { entry: 'inputs/lodash.js', run: false, edit: 'inputs/lodash.js', web: true },
  react: { entry: 'inputs/react.js', run: true, edit: 'inputs/react.js', web: true },
  rxjs: { entry: 'inputs/rxjs.js', run: true, edit: 'inputs/rxjs.js', web: true },
  app1500: { entry: 'inputs/generated/app1500/main.js', run: true, edit: 'inputs/generated/app1500/m750.js', web: true },
  tsapp500: { entry: 'inputs/generated/tsapp500/main.ts', run: true, ts: true, tsconfig: 'inputs/generated/tsapp500-check.json', edit: 'inputs/generated/tsapp500/m250.ts', web: true },
  preact: { entry: 'inputs/preactapp/main.tsx', run: true, ts: true, jsx: 'preact', buildConfig: 'inputs/preactapp/tsconfig.json', tsconfig: 'inputs/preactapp/tsconfig.json', edit: 'inputs/preactapp/components/Stats.tsx', web: true },
  vue: { entry: 'inputs/vueapp/main.js', run: true, edit: 'inputs/vueapp/main.js', web: true },
  solid: { entry: 'inputs/solidapp/main.js', run: true, conditions: ['node'], edit: 'inputs/solidapp/main.js', web: true },
  svelte: { entry: 'inputs/svelteapp/main.js', run: true, edit: 'inputs/generated/svelteapp/Item.js', web: true },
  monorepo: { entry: 'inputs/generated/monorepo/apps/web/src/main.ts', run: true, ts: true, buildConfig: 'inputs/generated/monorepo/tsconfig.json', tsconfig: 'inputs/generated/monorepo/tsconfig.json', edit: 'inputs/generated/monorepo/packages/data/src/m30.ts', web: true },
  datefns: { entry: 'inputs/datefns.js', run: true, edit: 'inputs/datefns.js', web: true },
  zod: { entry: 'inputs/zod.js', run: true, edit: 'inputs/zod.js', web: true },
  d3: { entry: 'inputs/d3.js', run: true, edit: 'inputs/d3.js', web: true },
};
export const externals = [...builtinModules, ...builtinModules.map((m) => 'node:' + m)];
export const NODE_ENV = '"production"';

export const pkgDir = (name) => realpathSync(join(here, 'node_modules', name));
// The file a package's `bin` field names.
export const pkgBin = (name, binName) => {
  const dir = pkgDir(name);
  const field = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).bin;
  return join(dir, typeof field === 'string' ? field : field[binName]);
};
// esbuild's native executable, from the platform package that sits next to esbuild (the install script that would link it is not run).
export const esbuildBinary = () => createRequire(join(pkgDir('esbuild'), 'package.json')).resolve(`@esbuild/${process.platform}-${process.arch}/bin/${process.platform === 'win32' ? 'esbuild.exe' : 'esbuild'}`);
export const pkgVersion = (name) => JSON.parse(readFileSync(join(here, 'node_modules', name, 'package.json'), 'utf8')).version;

// Parcel 3 is a native executable that npm installs as a platform package; the `parcel3` launcher is a Node script that starts it,
// and timing it would add a Node start-up, so the executable is run directly.
export const parcel3Binary = () => {
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

// The loader rules of rspack and webpack: TypeScript is only stripped (type checking is a separate matter, see typecheck.mjs); .tsx is parsed as JSX with the
// automatic runtime from the workload's JSX import source.
const swcRules = (loader, meta, extra = '') =>
  `[{ test: /\\.ts$/, loader: ${JSON.stringify(loader)}, options: { jsc: { parser: { syntax: 'typescript' } } }${extra} }, { test: /\\.tsx$/, loader: ${JSON.stringify(loader)}, options: { jsc: { parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic', importSource: ${JSON.stringify(meta.jsx ?? 'react')} } } } }${extra} }]`;
const extensions = "['.ts', '.tsx', '.js', '.mjs', '.json']";

// Pack looks for tsconfig.json from the working directory, not from the entry; the other tools that read a tsconfig look from each file, so for a workload with its own
// tsconfig.json (`buildConfig`) Pack is given that file, which is what running it in the project folder would do. `conditions` are package export conditions that
// a tool that does not add `node` for a Node build is asked to use (Pack, Vite); the others add it themselves.
const packConfig = (root, meta = {}) => [...(meta.buildConfig ? ['--tsconfig', join(root, meta.buildConfig)] : []), ...(meta.conditions ?? []).flatMap((c) => ['--condition', c])];
// How each tool is started. `c` is { entry, out, minify, map, dir, root, meta, production, watch }: `root` is the folder the entry is under (the folder of
// this file for a build; a writable copy for a rebuild run), `dir` is a folder for the tool's config and cache.
export const createTools = ({ production }) => {
  const tools = {
    rathkit: ({ entry, out, minify, map, watch, root = here, meta }) => ({ cmd: RK, args: ['bundle', entry, '--outfile', out, '--no-config', ...packConfig(root, meta), ...(production ? ['--define', `process.env.NODE_ENV=${NODE_ENV}`] : []), ...(minify ? ['--minify'] : []), ...(map ? ['--sourcemap'] : []), ...(watch ? ['--watch'] : [])] }),
    esbuild: ({ entry, out, minify, map, watch }) => ({ cmd: esbuildBinary(), args: [entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${out}`, '--log-level=error', '--banner:js=import { createRequire as __rkRequire } from "node:module"; import { fileURLToPath as __rkPath } from "node:url"; import { dirname as __rkDir } from "node:path"; const require = __rkRequire(import.meta.url), __filename = __rkPath(import.meta.url), __dirname = __rkDir(__filename);', ...(production ? [`--define:process.env.NODE_ENV=${NODE_ENV}`] : []), ...(minify ? ['--minify'] : []), ...(map ? ['--sourcemap'] : []), ...(watch ? ['--watch=forever'] : [])] }),
    rolldown: ({ entry, out, minify, map, watch }) => ({ cmd: process.execPath, args: [pkgBin('rolldown', 'rolldown'), entry, '--file', out, '--format', 'esm', '--platform', 'node', ...(production ? ['--transform.define', `process.env.NODE_ENV=${NODE_ENV}`] : []), ...(minify ? ['--minify'] : []), ...(map ? ['--sourcemap'] : []), ...(watch ? ['--watch'] : [])] }),
    rspack: ({ entry, out, minify, map, dir, root = here, meta = {}, watch, check }) => {
      const config = join(dir, 'rspack.config.mjs');
      writeFileSync(
        config,
        `${check === true ? `import { createRequire } from 'node:module';\nconst { TsCheckerRspackPlugin } = createRequire(${JSON.stringify(join(here, 'package.json'))})('ts-checker-rspack-plugin');\n` : ''}export default {${check === true ? ` plugins: [new TsCheckerRspackPlugin({ async: false, typescript: { configFile: ${JSON.stringify(join(root, meta.tsconfig))} } })],` : ''} mode: 'production', context: ${JSON.stringify(root)}, entry: ${JSON.stringify(join(root, entry))}, target: 'node', externalsPresets: { node: true }, devtool: ${map ? "'source-map'" : 'false'}, optimization: { minimize: ${minify}, nodeEnv: ${production ? "'production'" : 'false'} }, experiments: { outputModule: true }, resolve: { extensions: ${extensions} }, module: { rules: ${swcRules('builtin:swc-loader', meta, ", type: 'javascript/auto'")} }, output: { path: ${JSON.stringify(dirname(out))}, filename: ${JSON.stringify(out.split('/').pop())}, module: true, library: { type: 'module' }, chunkFormat: 'module' }, stats: 'errors-only' };\n`,
      );
      return { cmd: process.execPath, args: [pkgBin('@rspack/cli', 'rspack'), 'build', '--config', config, ...(watch ? ['--watch'] : [])] };
    },
    vite: ({ entry, out, minify, map, dir, root = here, watch, meta = {} }) => {
      // The values reach the config as data (a JSON file read at run time), never spliced into code.
      const config = join(dir, 'vite.config.mjs');
      const values = join(dir, 'vite.values.json');
      writeFileSync(values, JSON.stringify({ root, entry: join(root, entry), outDir: dirname(out), fileName: out.split('/').pop(), minify: minify ? 'oxc' : false, sourcemap: map, define: production ? { 'process.env.NODE_ENV': NODE_ENV } : {}, external: externals, conditions: meta.conditions ?? [] }));
      writeFileSync(
        config,
        `import { readFileSync } from 'node:fs';\nconst v = JSON.parse(readFileSync(new URL('./vite.values.json', import.meta.url), 'utf8'));\nexport default { root: v.root, logLevel: 'error', configFile: false, define: v.define, ...(v.conditions.length ? { resolve: { conditions: ['module', ...v.conditions, 'production'] } } : {}), build: { outDir: v.outDir, emptyOutDir: false, minify: v.minify, sourcemap: v.sourcemap, target: 'esnext', lib: { entry: v.entry, formats: ['es'], fileName: () => v.fileName }, rollupOptions: { external: v.external } } };\n`,
      );
      return { cmd: process.execPath, args: [pkgBin('vite', 'vite'), 'build', '--config', config, ...(watch ? ['--watch'] : [])] };
    },
    // webpack: the same options as the rspack case (production mode, minimizing and the NODE_ENV define switched by the case), with swc-loader for
    // TypeScript (type stripping only, no type check) and webpack's own default minimizer (terser).
    webpack: ({ entry, out, minify, map, dir, root = here, meta = {}, watch, check }) => {
      const config = join(dir, 'webpack.config.mjs');
      const loader = createRequire(join(here, 'package.json')).resolve('swc-loader');
      writeFileSync(
        config,
        `${check === true ? `import { createRequire } from 'node:module';\nconst ForkTsCheckerWebpackPlugin = createRequire(${JSON.stringify(join(here, 'package.json'))})('fork-ts-checker-webpack-plugin');\n` : ''}export default {${check === true ? ` plugins: [new ForkTsCheckerWebpackPlugin({ async: false, typescript: { configFile: ${JSON.stringify(join(root, meta.tsconfig))} } })],` : ''} mode: 'production', context: ${JSON.stringify(root)}, entry: ${JSON.stringify(join(root, entry))}, target: 'node', externalsPresets: { node: true }, devtool: ${map ? "'source-map'" : 'false'}, optimization: { minimize: ${minify}, nodeEnv: ${production ? "'production'" : 'false'} }, experiments: { outputModule: true }, resolve: { extensions: ${extensions} }, module: { rules: ${swcRules(loader, meta)} }, output: { path: ${JSON.stringify(dirname(out))}, filename: ${JSON.stringify(out.split('/').pop())}, module: true, library: { type: 'module' }, chunkFormat: 'module' }, stats: 'errors-only' };\n`,
      );
      return { cmd: process.execPath, args: [pkgBin('webpack-cli', 'webpack-cli'), 'build', '--config', config, ...(watch ? ['--watch'] : [])] };
    },
    // Rollup: node-resolve and commonjs (it reads neither on its own), replace for the NODE_ENV define, @rollup/plugin-typescript with its type checking
    // off (noCheck) for TypeScript, and @rollup/plugin-terser for the minified cases (Rollup has no minifier of its own). The plugins are loaded
    // from this folder's node_modules, because the config is written to the work folder.
    rollup: ({ entry, out, minify, map, dir, root = here, meta = {}, watch, check }) => {
      const config = join(dir, 'rollup.config.mjs');
      const jsx = meta.jsx ? `, jsx: 'react-jsx', jsxImportSource: ${JSON.stringify(meta.jsx)}` : '';
      const plugins = [
        production ? `load('@rollup/plugin-replace')({ preventAssignment: true, values: { 'process.env.NODE_ENV': ${JSON.stringify(NODE_ENV)} } })` : null,
        `load('@rollup/plugin-node-resolve')({ preferBuiltins: true, extensions: ['.mjs', '.js', '.json', '.ts', '.tsx'] })`,
        `load('@rollup/plugin-commonjs')()`,
        // With `check: true`, the plugin is set up the way its documentation shows: the project's tsconfig.json, and it type-checks (its default). `check: 'off'` is the
        // same with checking off (noCheck), for the build-only side of the type-check table, so that only the check differs. Without `check`, no tsconfig is read.
        check === true
          ? `load('@rollup/plugin-typescript')({ tsconfig: ${JSON.stringify(join(root, meta.tsconfig))} })`
          : check === 'off'
            ? `load('@rollup/plugin-typescript')({ tsconfig: ${JSON.stringify(join(root, meta.tsconfig))}, compilerOptions: { noCheck: true } })`
            : `load('@rollup/plugin-typescript')({ tsconfig: false, compilerOptions: { noCheck: true, module: 'esnext', target: 'esnext', moduleResolution: 'bundler'${jsx} } })`,
        minify ? `load('@rollup/plugin-terser')()` : null,
      ].filter(Boolean);
      writeFileSync(
        config,
        `import { createRequire } from 'node:module';\nconst r = createRequire(${JSON.stringify(join(here, 'package.json'))});\nconst load = (name) => { const m = r(name); return m.default ?? m; };\nexport default { input: ${JSON.stringify(join(root, entry))}, external: ${JSON.stringify(externals)}, plugins: [${plugins.join(', ')}], output: { file: ${JSON.stringify(out)}, format: 'es', sourcemap: ${map} }, onwarn(w) { ${check === true ? 'console.error(String(w.message));' : ''} } };\n`,
      );
      return { cmd: process.execPath, args: [pkgBin('rollup', 'rollup'), '--config', config, '--silent', ...(watch ? ['--watch'] : [])] };
    },
    parcel2: (c) => {
      const p = parcelCase(c);
      // A watch needs the cache (it is what a rebuild starts from), so it gets one in the run's own folder; a build is cold.
      // `parcel watch` has no --optimize or --no-optimize (it builds in development mode), so a minified watch is not possible with Parcel 2.
      const flags = c.watch ? p.flags.filter((f) => f !== '--no-optimize') : p.flags;
      return { cmd: process.execPath, args: [join(here, 'node_modules/parcel2/lib/bin.js'), c.watch ? 'watch' : 'build', p.entryPath, ...(c.watch ? ['--cache-dir', join(c.dir, '.parcel-cache'), '--no-hmr', '--watch-dir', c.root ?? here] : ['--no-cache']), '--no-autoinstall', ...flags], produced: p.produced, unsupported: c.watch && c.minify ? 'Parcel 2 has no minified watch mode (parcel watch builds in development mode)' : null };
    },
    parcel3: (c) => {
      const p = parcelCase(c);
      return { cmd: parcel3Binary(), args: [c.watch ? 'watch' : 'build', p.entryPath, ...p.flags], produced: p.produced };
    },
  };
  return tools;
};
// Both Parcel versions build from the `targets` in package.json (a Node ES module, node_modules included), write to the folder of the case,
// and name the file after the entry; the file is renamed to out.mjs afterwards. Parcel 2 is told not to keep its disk cache
// so that every run is a cold build; Parcel 3 has none. Without --optimize Parcel does not minify and does not scope-hoist.
const parcelCase = ({ entry, minify, map, dir, root = here }) => ({
  entryPath: join(root, entry),
  flags: ['--dist-dir', dir, '--no-content-hash', '--log-level', 'error', ...(minify ? [] : ['--no-optimize']), ...(map ? [] : ['--no-source-maps'])],
  produced: join(dir, basename(entry, extname(entry)) + '.js'),
});

export const toolVersions = () => ({
  esbuild: pkgVersion('esbuild'),
  rolldown: pkgVersion('rolldown'),
  rspack: `${pkgVersion('@rspack/core')} (cli ${pkgVersion('@rspack/cli')})`,
  vite: pkgVersion('vite'),
  webpack: `${pkgVersion('webpack')} (webpack-cli ${pkgVersion('webpack-cli')}, swc-loader ${pkgVersion('swc-loader')}, @swc/core ${pkgVersion('@swc/core')})`,
  rollup: `${pkgVersion('rollup')} (node-resolve ${pkgVersion('@rollup/plugin-node-resolve')}, commonjs ${pkgVersion('@rollup/plugin-commonjs')}, replace ${pkgVersion('@rollup/plugin-replace')}, typescript ${pkgVersion('@rollup/plugin-typescript')}, terser ${pkgVersion('@rollup/plugin-terser')})`,
  parcel2: pkgVersion('parcel2'),
  parcel3: pkgVersion('parcel3'),
  typescript: pkgVersion('typescript'),
  tsCheckerRspackPlugin: pkgVersion('ts-checker-rspack-plugin'),
  forkTsCheckerWebpackPlugin: pkgVersion('fork-ts-checker-webpack-plugin'),
  webpackDevServer: pkgVersion('webpack-dev-server'),
  rspackDevServer: pkgVersion('@rspack/dev-server'),
});
export const toolExecutables = () => ({ esbuild: esbuildBinary(), rolldown: pkgBin('rolldown', 'rolldown'), rspack: pkgBin('@rspack/cli', 'rspack'), vite: pkgBin('vite', 'vite'), webpack: pkgBin('webpack-cli', 'webpack-cli'), rollup: pkgBin('rollup', 'rollup'), parcel2: join(here, 'node_modules/parcel2/lib/bin.js'), parcel3: parcel3Binary() });
