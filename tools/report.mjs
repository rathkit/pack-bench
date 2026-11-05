// Turns a results.json (schema 2) into the Markdown of Pack's docs/benchmarks.md.
//   node tools/report.mjs FILE.json                 print the Machine paragraph and the tables
//   node tools/report.mjs FILE.json --into PATH     replace what is between <!-- pack-bench:begin --> and <!-- pack-bench:end --> in PATH
//   node tools/report.mjs --self-test               run on tools/fixtures/results.json (for CI)
// The hand-written analysis stays outside the markers and is rewritten by hand from the new tables.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { problems } from './check-results.mjs';

const labels = { rathkit: 'Rathkit Pack', esbuild: 'esbuild', rolldown: 'rolldown', rspack: 'rspack', vite: 'Vite', parcel2: 'Parcel 2', parcel3: 'Parcel 3' };
const workloadNames = {
  ts5: 'TypeScript compiler', three: 'three.js', lodash: 'lodash-es', react: 'React + react-dom/server', rxjs: 'rxjs',
  app1500: '1,500-module app', tsapp500: '500-module TypeScript app',
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
    `Parcel 2 ${res.tools.parcel2}`, `Parcel 3 ${res.tools.parcel3} (an alpha)`,
  ];
  parts.push(
    `- **Machine:** ${m.cpu} (${m.logicalCpus} logical CPUs available to the container, cpuset ${m.cpuset}), memory limit ${m.memoryLimit === 'max' ? 'none' : `${(Number(m.memoryLimit) / 2 ** 30).toFixed(0)} GB`}, Linux ${m.kernel}${m.note ? `; ${m.note}` : ''}. ` +
      (idle ? `The machine was idle: the load average was ${res.load.before.join(', ')} before the run and ${res.load.after.join(', ')} after it.` : `The machine was not idle: the load average was ${res.load.before.join(', ')} before the run, so every figure is slower than on a quiet machine and the small gaps are noisy.`) +
      ` Node ${res.node.replace(/^v/, '')}; Rathkit Pack ${res.pack.version.replace(/^rkp /, '')} at commit \`${String(res.pack.commit).slice(0, 7)}\` (release build, sha256 \`${res.pack.sha256.slice(0, 12)}\`); ${toolList.join(', ')}.` +
      ` Run on ${res.date.slice(0, 10)} in the pack-bench container, bench commit \`${String(res.bench.commit).slice(0, 7)}\`, image \`${String(res.bench.imageId).replace('sha256:', '').slice(0, 12)}\`; tools started through ${res.bench.launch === 'direct' ? 'their own executables' : "the package manager's launchers"}; ${res.runs} timed runs, outputs on a RAM disk.`,
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
  return parts.join('\n') + '\n';
};

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'results.json'), 'utf8'));
  const found = problems(fixture, { noGit: true });
  if (found.length) throw new Error(`fixture is not valid: ${found.join('; ')}`);
  const md = report(fixture);
  for (const expect of ['| | Rathkit Pack | esbuild |', '| TypeScript compiler |', 'failed', 'Geometric mean', 'bench commit', '## Output size']) {
    if (!md.includes(expect)) throw new Error(`report lacks: ${expect}`);
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
