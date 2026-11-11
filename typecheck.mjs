// Build plus type check, for the TypeScript workloads only. Each tool is set up the way it is commonly used (see `setups`): a separate `tsc --noEmit` after
// (or, for Vite, before) the build, a checker plugin that runs alongside the build, or a checker inside the build. Every process the setup starts is
// counted: the wall time is from the start of the first process to the exit of the last, and the memory is the largest sum of the resident sizes of
// all the processes of the setup at one moment (sampled every 10 ms; shared pages are counted once per process, so it is an upper bound).
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { here, pkgDir } from './lib.mjs';
import { runToEnd } from './procs.mjs';

export const setups = {
  esbuild: { kind: 'after', text: 'esbuild, then `tsc --noEmit`' },
  rolldown: { kind: 'after', text: 'rolldown, then `tsc --noEmit`' },
  vite: { kind: 'before', text: '`tsc --noEmit`, then `vite build` (the starter template runs `tsc -b && vite build`)' },
  parcel2: { kind: 'after', text: 'Parcel 2, then `tsc --noEmit`' },
  parcel3: { kind: 'after', text: 'Parcel 3, then `tsc --noEmit`' },
  rspack: { kind: 'alongside', text: 'ts-checker-rspack-plugin (`async: false`) in the rspack build' },
  webpack: { kind: 'alongside', text: 'fork-ts-checker-webpack-plugin (`async: false`) in the webpack build' },
  rollup: { kind: 'inside', text: '@rollup/plugin-typescript with checking on (its default), reading the project tsconfig' },
};
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const summary = (times, peaks) => ({ med: median(times), min: Math.min(...times), rss: Math.max(...peaks) / 1024 });

export const tscSpec = (meta) => ({ cmd: process.execPath, args: [join(pkgDir('typescript'), 'lib', 'tsc.js'), '--noEmit', '-p', join(here, meta.tsconfig)] });

// Runs `steps` (a list of specs, one after another) `runs` times after one warm-up; a step that exits with an error fails the case.
const measureSteps = async (steps, runs, between) => {
  const times = [], peaks = [];
  for (let i = -1; i < runs; i++) {
    between?.();
    const t = process.hrtime.bigint();
    let peak = 0;
    for (const spec of steps) {
      const r = await runToEnd(spec, { cwd: here });
      if (!r.ok) return { failed: `${spec.args.filter((a) => /\.(m?js|cjs)$/.test(a)).map((a) => a.split('/').slice(-3).join('/')).join(' ')}: ${(r.err || r.out).trim().split('\n').slice(-2).join(' | ').slice(0, 200)}` };
      peak = Math.max(peak, r.peakSum);
    }
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    if (i >= 0) (times.push(ms), peaks.push(peak));
  }
  return summary(times, peaks);
};

export const measureCheck = async ({ tool, name, meta, tools, workDir, runs }) => {
  const dir = join(workDir, 'check-out', `${name}-${tool}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'out.mjs');
  const c = { entry: meta.entry, out, minify: true, map: false, dir, meta };
  // Between runs only the outputs are removed (the tool's config files are in the same folder), so every run is a cold build.
  const reset = () => {
    rmSync(out, { force: true });
    rmSync(join(dir, 'main.js'), { force: true });
  };
  const setup = setups[tool];
  const buildOnly = tools[tool]({ ...c, check: 'off' });
  const buildOnlyResult = await measureSteps([buildOnly], runs, reset);
  let withCheck;
  if (setup.kind === 'after') withCheck = await measureSteps([tools[tool]({ ...c, check: 'off' }), tscSpec(meta)], runs, reset);
  else if (setup.kind === 'before') withCheck = await measureSteps([tscSpec(meta), tools[tool]({ ...c, check: 'off' })], runs, reset);
  else withCheck = await measureSteps([tools[tool]({ ...c, check: true })], runs, reset);
  rmSync(dir, { recursive: true, force: true });
  return { name, tool, kind: setup.kind, setup: setup.text, buildOnly: buildOnlyResult, withCheck, failed: buildOnlyResult.failed ?? withCheck.failed ?? null };
};
export const measureTsc = async ({ name, meta, runs }) => ({ name, tool: 'tsc', kind: 'alone', setup: '`tsc --noEmit` alone', withCheck: await measureSteps([tscSpec(meta)], runs) });
