// Starting a tool and watching its whole process tree: peak memory of everything it starts, and a clean stop (a process group, checked afterwards).
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kb = (text, key) => {
  const m = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
  return m ? Number(m[1]) : 0;
};
// Every live process: pid, parent, group, resident size and its own peak (both in kB).
const snapshot = () => {
  const all = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const status = readFileSync(`/proc/${name}/status`, 'utf8');
      all.push({ pid: Number(name), state: rest[0], ppid: Number(rest[1]), pgrp: Number(rest[2]), rss: kb(status, 'VmRSS'), hwm: kb(status, 'VmHWM') });
    } catch {}
  }
  return all;
};
const descendants = (all, root) => {
  const keep = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all) if (!keep.has(p.pid) && keep.has(p.ppid)) (keep.add(p.pid), (grew = true));
  }
  return all.filter((p) => keep.has(p.pid));
};

// A process that runs until it is stopped. `peak` follows it: the largest sum of the resident sizes of the whole tree at one moment
// (sampled), and `maxOne`, the largest peak of any one process in the tree (the kernel's own high-water mark).
export class Running {
  constructor(spec, { cwd, env, sampleMs = 10 } = {}) {
    this.child = spawn(spec.cmd, spec.args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.pid = this.child.pid;
    this.out = '';
    this.err = '';
    this.exited = new Promise((resolve) => this.child.on('close', (code, signal) => ((this.code = code), (this.signal = signal), resolve())));
    this.child.stdout.on('data', (d) => (this.out = (this.out + d).slice(-20000)));
    this.child.stderr.on('data', (d) => (this.err = (this.err + d).slice(-20000)));
    this.child.on('error', (e) => (this.err += String(e)));
    this.peakSum = 0;
    this.maxOne = 0;
    this.timer = setInterval(() => this.sample(), sampleMs);
  }
  sample() {
    const tree = descendants(snapshot(), this.pid);
    this.peakSum = Math.max(this.peakSum, tree.reduce((s, p) => s + p.rss, 0));
    this.maxOne = Math.max(this.maxOne, ...tree.map((p) => p.hwm));
  }
  // Stop the tree: SIGTERM to the group, SIGKILL after two seconds, then check that nothing of the group is left.
  async stop() {
    this.sample();
    clearInterval(this.timer);
    // A zombie is a dead process nobody has collected (the container has no init to do it); it holds nothing, so it does not count.
    const group = () => snapshot().filter((p) => p.pgrp === this.pid && p.state !== 'Z');
    try {
      process.kill(-this.pid, 'SIGTERM');
    } catch {}
    for (let i = 0; i < 40 && group().length; i++) await sleep(50);
    if (group().length) {
      try {
        process.kill(-this.pid, 'SIGKILL');
      } catch {}
      for (let i = 0; i < 40 && group().length; i++) await sleep(50);
    }
    const left = group();
    this.left = left.map((p) => p.pid);
    return this.left;
  }
}

// Run a command to its end; resolves with the wall time and the memory of the whole tree.
let timedCounter = 0;
export const runToEnd = async (spec, opts = {}) => {
  // Run under /usr/bin/time too: its %M is the kernel's own high-water mark of the largest process, which a 10 ms sample cannot catch for a build that takes 10 ms.
  const report = join(tmpdir(), `time-${process.pid}-${timedCounter++}`);
  const t = process.hrtime.bigint();
  const r = new Running({ cmd: '/usr/bin/time', args: ['-f', '%M', '-o', report, '--', spec.cmd, ...spec.args] }, opts);
  await r.exited;
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  r.sample();
  clearInterval(r.timer);
  // Anything the command left behind in its group is stopped (a worker that outlived its parent).
  await r.stop();
  let timed = 0;
  try {
    timed = Number(readFileSync(report, 'utf8').trim().split('\n').pop()) || 0;
    rmSync(report, { force: true });
  } catch {}
  // The largest of the sampled sum over the whole tree and the largest single process the kernel saw (kB).
  return { ms, ok: r.code === 0, err: r.err, out: r.out, peakSum: Math.max(r.peakSum, timed), maxOne: Math.max(r.maxOne, timed) };
};
