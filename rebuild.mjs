// Warm rebuild: the tool is started in its own watch mode on a writable copy of the project, the first build is waited for, then one project file is
// changed again and again; the time from writing the file to the output holding the change is the rebuild time. Nothing is read from the tool's
// log: only the output file is looked at, the same way for every tool.
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { here } from './lib.mjs';
import { Running, sleep } from './procs.mjs';

const hr = () => Number(process.hrtime.bigint()) / 1e6;
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

// A writable copy of what the workload needs: the hand-written inputs, the generated folder of this workload, a link to the installed packages and
// package.json (Parcel reads its `targets` from it).
export const copyProject = (meta, proj) => {
  rmSync(proj, { recursive: true, force: true });
  mkdirSync(proj, { recursive: true });
  const wanted = [meta.entry, meta.edit].map((p) => p.match(/^inputs\/generated\/([^/]+)/)?.[1]).filter(Boolean);
  const generated = join(here, 'inputs', 'generated') + sep;
  cpSync(join(here, 'inputs'), join(proj, 'inputs'), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => !src.startsWith(generated) || wanted.some((w) => src === join(here, 'inputs', 'generated', w) || src.startsWith(join(here, 'inputs', 'generated', w) + sep)),
  });
  symlinkSync(join(here, 'node_modules'), join(proj, 'node_modules'), 'dir');
  copyFileSync(join(here, 'package.json'), join(proj, 'package.json'));
};

const stamp = (file) => {
  try {
    const s = statSync(file, { bigint: true });
    return `${s.mtimeNs}:${s.size}`;
  } catch {
    return null;
  }
};
// Wait until `file` exists and holds text that `test` accepts; polls the file's time and size every 2 ms and reads it only when those changed.
const waitFor = async (file, test, ms, running) => {
  const end = hr() + ms;
  let seen = null;
  while (hr() < end) {
    if (running && running.code !== undefined && running.code !== null) return null;
    const now = stamp(file);
    if (now && now !== seen) {
      seen = now;
      try {
        if (test(readFileSync(file, 'utf8'))) return hr();
      } catch {}
    }
    await sleep(2);
  }
  return null;
};

// opts: tool, name, meta, mode ('plain' | 'minify'), tools (createTools result), workDir, edits, settleMs
export const measureRebuild = async ({ tool, name, meta, mode, tools, workDir, edits = 7, settleMs = 800, firstMs = 180000, editMs = 60000 }) => {
  const key = `${name}-${mode}-${tool}`;
  const proj = join(workDir, 'watch', key);
  const dir = join(workDir, 'watch-out', key);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'out.mjs');
  const spec = tools[tool]({ entry: meta.entry, out, minify: mode === 'minify', map: false, dir, root: proj, meta, watch: true });
  if (spec.unsupported) return { start: null, times: [], rss: null, failed: null, unsupported: spec.unsupported };
  copyProject(meta, proj);
  const watched = spec.produced ?? out;
  const editFile = join(proj, meta.edit);
  const original = readFileSync(editFile, 'utf8');
  const result = { start: null, times: [], rss: null, failed: null };
  const t0 = hr();
  const running = new Running(spec, { cwd: proj });
  try {
    const first = await waitFor(watched, (text) => text.length > 0, firstMs, running);
    if (first === null) throw new Error(`no first build: ${running.err.trim().split('\n').slice(-2).join(' | ').slice(0, 160)}`);
    result.start = first - t0;
    await sleep(settleMs);
    // The build may have written the file in two steps; the first edit starts from what is there now.
    for (let k = 1; k <= edits; k++) {
      const n = 4242000 + k;
      const pattern = new RegExp(`__rkEdit\\s*=\\s*${n}\\b`);
      const t = hr();
      writeFileSync(editFile, `${original}\nglobalThis.__rkEdit = ${n};\n`);
      const done = await waitFor(watched, (text) => pattern.test(text), editMs, running);
      if (done === null) {
        result.failed = `edit ${k}: no rebuild within ${editMs / 1000} s${running.code !== undefined && running.code !== null ? ` (the tool exited with ${running.code})` : ''}`;
        break;
      }
      result.times.push(done - t);
      await sleep(settleMs);
    }
    running.sample();
    result.rss = running.maxOne / 1024;
  } catch (e) {
    result.failed = String(e.message ?? e);
  } finally {
    writeFileSync(editFile, original);
    await running.stop();
    rmSync(proj, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
  if (result.times.length) Object.assign(result, { med: median(result.times), min: Math.min(...result.times) });
  return result;
};
