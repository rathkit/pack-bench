// Refuses a results.json that lacks the metadata a published figure must carry.
//   node tools/check-results.mjs FILE.json [--smoke] [--no-git]
//   --smoke   a smoke test (fewer than 7 runs, any commit); never publishable
//   --no-git  do not look for bench.commit in the history of origin/main (CI fixtures)
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export const required = [
  'schema', 'date', 'pack.version', 'pack.sha256', 'pack.commit', 'bench.commit', 'bench.imageId', 'bench.launch', 'bench.rootfs',
  'node', 'tools.esbuild', 'tools.rolldown', 'tools.rspack', 'tools.vite', 'tools.parcel2', 'tools.parcel3',
  'machine.cpu', 'machine.logicalCpus', 'machine.cpuset', 'machine.memoryLimit', 'machine.kernel', 'machine.note',
  'load.before', 'load.after', 'env', 'runs', 'modes', 'argv', 'rows',
];
const dig = (o, path) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);

export const problems = (results, { smoke = false, noGit = false } = {}) => {
  const out = [];
  // webpack and Rollup came later: their versions are required only when the results hold rows for them.
  const extra = ['webpack', 'rollup'].filter((t) => Array.isArray(results.rows) && results.rows.some((r) => r.tool === t)).map((t) => `tools.${t}`);
  for (const path of [...required, ...extra]) {
    const v = dig(results, path);
    if (v === undefined || v === null || v === '') {
      // The host note may be empty only in a smoke test.
      if (path === 'machine.note' && smoke) continue;
      out.push(`missing: ${path}`);
    }
  }
  // Schema 3 adds the optional sections `rebuild`, `dev` and `typecheck` (and the versions of what they use); `rows` is the same as in schema 2.
  if (results.schema !== 2 && results.schema !== 3) out.push(`schema is ${results.schema}, expected 2 or 3`);
  const has = (key) => Array.isArray(results[key]) && results[key].length > 0;
  const need = (path, why) => {
    const v = dig(results, path);
    if (v === undefined || v === null || v === '') out.push(`missing: ${path} (${why})`);
  };
  if (has('rebuild')) {
    need('edits', 'rebuild section');
    need('rebuildModes', 'rebuild section');
  }
  if (has('dev')) {
    for (const [tool, path] of [['webpack', 'tools.webpackDevServer'], ['rspack', 'tools.rspackDevServer']]) if (results.dev.some((r) => r.tool === tool)) need(path, 'dev section');
  }
  if (has('typecheck')) {
    need('tools.typescript', 'typecheck section');
    for (const [tool, path] of [['webpack', 'tools.forkTsCheckerWebpackPlugin'], ['rspack', 'tools.tsCheckerRspackPlugin']]) if (results.typecheck.some((r) => r.tool === tool)) need(path, 'typecheck section');
  }
  if (!smoke) {
    if (!(results.runs >= 7)) out.push(`runs is ${results.runs}, a published figure needs 7 or more`);
    const commit = results.bench?.commit;
    if (typeof commit === 'string') {
      if (commit.endsWith('-dirty')) out.push('bench.commit is a dirty tree');
      else if (!noGit) {
        const r = spawnSync('git', ['merge-base', '--is-ancestor', commit, 'origin/main'], { encoding: 'utf8' });
        if (r.status !== 0) out.push(`bench.commit ${commit} is not on origin/main (push it first, or fetch)`);
      }
    }
  }
  return out;
};

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node tools/check-results.mjs FILE.json [--smoke] [--no-git]');
    process.exit(2);
  }
  const found = problems(JSON.parse(readFileSync(file, 'utf8')), { smoke: process.argv.includes('--smoke'), noGit: process.argv.includes('--no-git') });
  for (const p of found) console.error(`results: ${p}`);
  if (found.length) process.exit(1);
  console.log('results: ok');
}
