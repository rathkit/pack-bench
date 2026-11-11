// Turns a results.json (schema 2) into the Markdown of Pack's docs/benchmarks.md.
//   node tools/report.mjs FILE.json                 print the Machine paragraph and the tables
//   node tools/report.mjs FILE.json --into PATH     replace what is between <!-- pack-bench:begin --> and <!-- pack-bench:end --> in PATH
//   node tools/report.mjs --self-test               run on tools/fixtures/results.json (for CI)
// The hand-written analysis stays outside the markers and is rewritten by hand from the new tables.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { problems } from './check-results.mjs';

const labels = { rathkit: 'Rathkit Pack', esbuild: 'esbuild', rolldown: 'rolldown', rspack: 'rspack', vite: 'Vite', webpack: 'webpack', rollup: 'Rollup', parcel2: 'Parcel 2', parcel3: 'Parcel 3' };
const workloadNames = {
  ts5: 'TypeScript compiler', three: 'three.js', lodash: 'lodash-es', react: 'React + react-dom/server', rxjs: 'rxjs',
  app1500: '1,500-module app', tsapp500: '500-module TypeScript app',
  preact: 'Preact app (TSX)', vue: 'Vue app (render functions)', solid: 'Solid app (no JSX)', svelte: 'Svelte app (precompiled)',
  monorepo: 'Monorepo-style TypeScript app', datefns: 'date-fns', zod: 'Zod', d3: 'D3',
};
const modeTitles = { plain: 'Plain', minify: 'Minified', 'minify+map': 'Minified with a source map' };
const modeWords = { plain: 'plain', minify: 'minified', 'minify+map': 'minified with a map' };
const ratioLabel = (tool) => labels[tool];

export const report = (res) => {
  const tools = Object.keys(labels).filter((t) => res.rows.some((r) => r.tool === t));
  const names = Object.keys(workloadNames).filter((w) => res.rows.some((r) => r.name === w));
  const get = (w, m, t) => res.rows.find((r) => r.name === w && r.mode === m && r.tool === t);
  const table = (cell) => {
    const out = [`| | ${tools.map((t) => labels[t]).join(' | ')} |`, `|---|${tools.map(() => '---').join('|')}|`];
    for (const w of names) out.push(`| ${workloadNames[w]} | ${tools.map((t) => { const r = get(w, cell.mode, t); return !r || r.failed ? 'failed' : cell.of(r); }).join(' | ')} |`);
    return out.join('\n');
  };
  const parts = [];
  const m = res.machine;
  const idle = res.load.before[0] < 1.0;
  const toolList = [
    `esbuild ${res.tools.esbuild}`, `rolldown ${res.tools.rolldown}`, `@rspack/core ${res.tools.rspack.split(' ')[0]}`, `Vite ${res.tools.vite}`,
    // webpack and Rollup print their plugins and loaders too, because the figure depends on them.
    ...(res.rows.some((r) => r.tool === 'webpack') ? [`webpack ${res.tools.webpack}`] : []),
    ...(res.rows.some((r) => r.tool === 'rollup') ? [`Rollup ${res.tools.rollup}`] : []),
    `Parcel 2 ${res.tools.parcel2}`, `Parcel 3 ${res.tools.parcel3} (an alpha)`,
    // The development servers and checkers come with the sections that use them.
    ...(res.dev?.some((r) => r.tool === 'webpack') ? [`webpack-dev-server ${res.tools.webpackDevServer}`] : []),
    ...(res.dev?.some((r) => r.tool === 'rspack') ? [`@rspack/dev-server ${res.tools.rspackDevServer}`] : []),
    ...(res.typecheck?.length ? [`TypeScript ${res.tools.typescript} (tsc)`] : []),
    ...(res.typecheck?.some((r) => r.tool === 'rspack') ? [`ts-checker-rspack-plugin ${res.tools.tsCheckerRspackPlugin}`] : []),
    ...(res.typecheck?.some((r) => r.tool === 'webpack') ? [`fork-ts-checker-webpack-plugin ${res.tools.forkTsCheckerWebpackPlugin}`] : []),
  ];
  parts.push(
    `- **Machine:** ${m.cpu} (${m.logicalCpus} logical CPUs available to the container, cpuset ${m.cpuset}), memory limit ${m.memoryLimit === 'max' ? 'none' : `${(Number(m.memoryLimit) / 2 ** 30).toFixed(0)} GB`}, Linux ${m.kernel}${m.note ? `; ${m.note}` : ''}. ` +
      (idle ? `The machine was idle: the load average was ${res.load.before.join(', ')} before the run and ${res.load.after.join(', ')} after it.` : `The machine was not idle: the load average was ${res.load.before.join(', ')} before the run, so every figure is slower than on a quiet machine and the small gaps are noisy.`) +
      ` Node ${res.node.replace(/^v/, '')}; Rathkit Pack ${res.pack.version.replace(/^rkp /, '')} at commit \`${String(res.pack.commit).slice(0, 7)}\` (release build, sha256 \`${res.pack.sha256.slice(0, 12)}\`); ${toolList.join(', ')}.` +
      ` Run on ${res.date.slice(0, 10)} in the pack-bench container, bench commit \`${String(res.bench.commit).slice(0, 7)}\`, image \`${String(res.bench.imageId).replace('sha256:', '').slice(0, 12)}\`; tools started through ${res.bench.launch === 'direct' ? 'their own executables' : "the package manager's launchers"}; ${res.runs} timed runs, outputs on a RAM disk.`,
  );
  parts.push('');
  parts.push(
    `Reproduce: in [rathkit/pack-bench](https://github.com/rathkit/pack-bench) at commit \`${String(res.bench.commit).slice(0, 7)}\`, build Pack at commit \`${String(res.pack.commit).slice(0, 7)}\` with \`container/build-pack.sh\`, then run \`container/run.sh --pack-bin <that binary> -- ${res.argv.join(' ')}\`.`,
  );
  parts.push('');
  parts.push('## Time (median ms, lower is better)');
  for (const mode of res.modes) parts.push('', `${modeTitles[mode] ?? mode}:`, '', table({ mode, of: (r) => r.med.toFixed(0) }));
  if (tools.includes('rathkit')) {
    const sentences = res.modes.map((mode) => {
      const each = tools.filter((t) => t !== 'rathkit').map((t) => {
        const ratios = names.map((w) => [get(w, mode, t), get(w, mode, 'rathkit')]).filter(([a, b]) => a && b && !a.failed && !b.failed).map(([a, b]) => a.med / b.med);
        return ratios.length ? `${ratioLabel(t)} ${Math.exp(ratios.reduce((s, x) => s + Math.log(x), 0) / ratios.length).toFixed(1)}x` : null;
      }).filter(Boolean);
      return `${modeWords[mode] ?? mode}, ${each.join(', ')}`;
    });
    parts.push('', `Geometric mean of each tool's time relative to Rathkit Pack, over the workloads each tool built: ${sentences.join(';\n')}.`);
  }
  const last = res.modes.at(-1);
  parts.push('', `## Peak memory (MB, ${modeWords[last] ?? last})`, '', table({ mode: last, of: (r) => r.rss.toFixed(0) }));
  const sizeMode = res.modes.filter((x) => x.startsWith('minify'))[0] ?? res.modes[0];
  parts.push('', `## Output size (KB / gzip KB, ${modeWords[sizeMode] ?? sizeMode})`, '', table({ mode: sizeMode, of: (r) => `${(r.size.bytes / 1024).toFixed(0)} / ${(r.size.gzip / 1024).toFixed(0)}` }));
  parts.push('', `## Does the output run and print the same? (${modeWords[res.modes[0]] ?? res.modes[0]})`, '', table({ mode: res.modes[0], of: (r) => r.runs }));
  parts.push(...extraSections(res, labels, workloadNames));
  return parts.join('\n') + '\n';
};

const fmtMs = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
// The sections that came with schema 3: warm rebuild, server start and HMR latency, and build plus type check. Each is its own table, never mixed with the build tables.
const extraSections = (res) => {
  const parts = [];
  const names = Object.keys(workloadNames);
  if (res.rebuild?.length) {
    const tools = Object.keys(labels).filter((t) => res.rebuild.some((r) => r.tool === t));
    const get = (w, m, t) => res.rebuild.find((r) => r.name === w && r.mode === m && r.tool === t);
    parts.push('', '## Warm rebuild in watch mode (median ms, lower is better)', '');
    for (const mode of res.rebuildModes) {
      parts.push(`${modeTitles[mode] ?? mode}:`, '', `| | ${tools.map((t) => labels[t]).join(' | ')} |`, `|---|${tools.map(() => '---').join('|')}|`);
      for (const w of names.filter((n) => res.rebuild.some((r) => r.name === n))) {
        parts.push(`| ${workloadNames[w]} | ${tools.map((t) => { const r = get(w, mode, t); return !r || !r.times?.length ? (r?.unsupported ? 'n/a' : 'failed') : fmtMs(r.med) + (r.failed ? '*' : ''); }).join(' | ')} |`);
      }
      parts.push('');
    }
    const first = res.rebuild.filter((r) => r.mode === res.rebuildModes[0] && r.start != null);
    parts.push(`Each tool runs in its own watch mode on a writable copy of the project, the first build is waited for, then one file of the project is changed ${res.edits} times (each change appends one statement), and the time from writing the file to the output file holding the statement is taken; the median of the ${res.edits} is shown. ${first.length ? '' : ''}`.trim());
  }
  if (res.dev?.length) {
    const tools = Object.keys(labels).filter((t) => res.dev.some((r) => r.tool === t));
    const get = (w, t) => res.dev.find((r) => r.name === w && r.tool === t);
    const rows = names.filter((n) => res.dev.some((r) => r.name === n));
    parts.push('', '## Development server: start and HMR latency (median ms, lower is better)', '', 'Start, until the page and every module it imports have been answered:', '', `| | ${tools.map((t) => labels[t]).join(' | ')} |`, `|---|${tools.map(() => '---').join('|')}|`);
    for (const w of rows) parts.push(`| ${workloadNames[w]} | ${tools.map((t) => { const r = get(w, t); return !r || !r.start?.length ? 'failed' : fmtMs(r.startMed); }).join(' | ')} |`);
    parts.push('', 'HMR latency, from writing a change to a module that accepts it to the update notice (the kind of notice is in the second table):', '', `| | ${tools.map((t) => labels[t]).join(' | ')} |`, `|---|${tools.map(() => '---').join('|')}|`);
    for (const w of rows) parts.push(`| ${workloadNames[w]} | ${tools.map((t) => { const r = get(w, t); return !r || !r.hmr?.length ? (r?.hmrFailed ? 'failed' : 'none') : fmtMs(r.hmrMed) + (r.hmrFailed ? '*' : ''); }).join(' | ')} |`);
    parts.push('', `Notice kinds: ${tools.map((t) => `${labels[t]} ${[...new Set(res.dev.filter((r) => r.tool === t && r.hmrType).map((r) => r.hmrType))].join('/') || 'none'}`).join('; ')}. Without a development server: ${Object.entries(res.devNotes ?? {}).map(([t, n]) => `${labels[t] ?? t} (${n})`).join('; ')}.`);
  }
  if (res.typecheck?.length) {
    const checked = names.filter((n) => res.typecheck.some((r) => r.name === n));
    parts.push('', '## Build plus type check (TypeScript workloads only; wall time and peak memory of every process of the setup)');
    for (const w of checked) {
      const rows = res.typecheck.filter((r) => r.name === w);
      parts.push('', `${workloadNames[w]}:`, '', '| Tool and setup | Build only (ms) | Build + check (ms) | The check adds (ms) | Memory build only (MB) | Memory build + check (MB) |', '|---|---|---|---|---|---|');
      const tsc = rows.find((r) => r.tool === 'tsc');
      if (tsc) parts.push(`| ${tsc.setup} | - | ${tsc.withCheck.failed ? 'failed' : fmtMs(tsc.withCheck.med)} | - | - | ${tsc.withCheck.failed ? '-' : tsc.withCheck.rss.toFixed(0)} |`);
      for (const t of Object.keys(labels)) {
        if (t === 'rathkit') {
          parts.push(`| ${labels[t]}: no type checker | not measured | not measured | - | - | - |`);
          continue;
        }
        const r = rows.find((x) => x.tool === t);
        if (!r) continue;
        if (r.failed) parts.push(`| ${labels[t]}: ${r.setup} | failed | failed | - | - | - |`);
        else parts.push(`| ${labels[t]}: ${r.setup} | ${fmtMs(r.buildOnly.med)} | ${fmtMs(r.withCheck.med)} | ${fmtMs(r.withCheck.med - r.buildOnly.med)} | ${r.buildOnly.rss.toFixed(0)} | ${r.withCheck.rss.toFixed(0)} |`);
      }
    }
  }
  return parts;
};

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  // schema 2 (build tables only) and schema 3 (with the rebuild, dev server and type-check sections)
  for (const [file, expects] of [
    ['results.json', ['| | Rathkit Pack | esbuild |', '| TypeScript compiler |', 'failed', 'Geometric mean', 'bench commit', 'Reproduce: in', '## Output size']],
    ['results3.json', ['## Warm rebuild in watch mode', '## Development server: start and HMR latency', '## Build plus type check', 'Rathkit Pack: no type checker', 'n/a', 'TypeScript 0.0.0 (tsc)']],
  ]) {
    const fixture = JSON.parse(readFileSync(join(here, 'fixtures', file), 'utf8'));
    const found = problems(fixture, { noGit: true });
    if (found.length) throw new Error(`${file} is not valid: ${found.join('; ')}`);
    const md = report(fixture);
    for (const expect of expects) {
      if (!md.includes(expect)) throw new Error(`report of ${file} lacks: ${expect}`);
    }
  }
  console.log('report: self-test ok');
} else if (args.length) {
  const into = args.indexOf('--into') >= 0 ? args[args.indexOf('--into') + 1] : null;
  const file = args.find((a) => !a.startsWith('--') && a !== into);
  const md = report(JSON.parse(readFileSync(file, 'utf8')));
  if (!into) process.stdout.write(md);
  else {
    const doc = readFileSync(into, 'utf8');
    const [begin, end] = ['<!-- pack-bench:begin -->', '<!-- pack-bench:end -->'];
    const a = doc.indexOf(begin), b = doc.indexOf(end);
    if (a < 0 || b < a) throw new Error(`${into} has no ${begin} ... ${end} markers`);
    writeFileSync(into, doc.slice(0, a + begin.length) + '\n' + md + doc.slice(b));
  }
} else {
  console.error('usage: node tools/report.mjs FILE.json [--into PATH] | --self-test');
  process.exit(2);
}
