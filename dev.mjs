// Server start and HMR latency, for the tools that have a development server.
//
// No browser is involved. A page load is imitated by asking the server for the page, then for every script it names, then for every module those import
// (six requests at a time, as a browser does), and the server is "started" when all of that has been answered. A development server that does not
// bundle (Vite) is asked for every module of the app, so it is not credited for work it has not done yet. The page is never run.
// The HMR latency is from writing a change to a module (one that accepts its own update) to the message that tells the page about it, read from the same
// channel the tool's own client listens to (server-sent events or a WebSocket). What the page then does with it is not measured.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { here, RK, pkgBin, esbuildBinary, parcel3Binary, workloads } from './lib.mjs';
import { copyProject } from './rebuild.mjs';
import { Running, sleep } from './procs.mjs';

const hr = () => Number(process.hrtime.bigint()) / 1e6;
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const HOST = '127.0.0.1';

// The statement a module needs to take its own update, per tool.
const accept = { rathkit: 'if (import.meta.hot) import.meta.hot.accept();', vite: 'if (import.meta.hot) import.meta.hot.accept();', webpack: 'if (import.meta.webpackHot) import.meta.webpackHot.accept();', rspack: 'if (import.meta.webpackHot) import.meta.webpackHot.accept();', parcel2: 'if (module.hot) module.hot.accept();', parcel3: 'if (module.hot) module.hot.accept();', esbuild: '' };

const swc = (loader, meta, extra = '') =>
  `[{ test: /\\.ts$/, loader: ${JSON.stringify(loader)}, options: { jsc: { parser: { syntax: 'typescript' } } }${extra} }, { test: /\\.tsx$/, loader: ${JSON.stringify(loader)}, options: { jsc: { parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic', development: true, importSource: ${JSON.stringify(meta.jsx ?? 'react')} } } } }${extra} }]`;
const webpackLike = ({ entry, root, dir, port, meta, rules, mode = 'development' }) => {
  const config = join(dir, 'config.mjs');
  mkdirSync(join(dir, 'www'), { recursive: true });
  writeFileSync(join(dir, 'www', 'index.html'), readFileSync(join(root, 'index.html')));
  writeFileSync(
    config,
    `export default { mode: 'development', context: ${JSON.stringify(root)}, entry: ${JSON.stringify(join(root, entry))}, target: 'web', externals: [({ request }, done) => (/^node:/.test(request) ? done(null, '{}', 'var') : done())], resolve: { extensions: ['.ts', '.tsx', '.js', '.mjs', '.json'] }, module: { rules: ${rules} }, output: { path: ${JSON.stringify(join(dir, 'dist'))}, filename: 'bundle.js', publicPath: '/' }, devServer: { host: ${JSON.stringify(HOST)}, port: ${port}, hot: true, open: false, allowedHosts: 'all', static: { directory: ${JSON.stringify(join(dir, 'www'))}, watch: false }, client: { overlay: false, logging: 'none' } }, stats: 'errors-only', infrastructureLogging: { level: 'error' } };\n`,
  );
  return config;
};

// Each tool: the command, the script the page names, and how to listen for its update notices.
export const devTools = {
  rathkit: ({ entry, port }) => ({ spec: { cmd: RK, args: ['serve', entry, '--port', String(port), '--host', HOST, '--no-config', '--hmr', '--platform-browser', '--define', 'process.env.NODE_ENV="development"'] }, script: null, ready: (page) => !page.includes(`/${entry}"`) && /src="\/[^"]+\.js"/.test(page), channel: { kind: 'sse', path: '/__rathkit/events', hit: (m) => ['hmr', 'full-reload', 'css-update'].includes(m.type) } }),
  esbuild: ({ entry, root, dir, port }) => ({ spec: { cmd: esbuildBinary(), args: [entry, '--bundle', '--format=esm', '--platform=browser', `--outdir=${join(root, 'out')}`, `--servedir=${root}`, `--serve=${HOST}:${port}`, '--watch=forever', '--log-level=error', '--define:process.env.NODE_ENV="development"', '--loader:.js=jsx'] }, script: `/out/${basename(entry, extname(entry))}.js`, channel: { kind: 'sse', path: '/esbuild', event: 'change', hit: () => true } }),
  vite: ({ root, dir, port, entry }) => {
    const config = join(dir, 'vite.config.mjs');
    writeFileSync(config, `export default { root: ${JSON.stringify(root)}, configFile: false, logLevel: 'error', cacheDir: ${JSON.stringify(join(dir, '.vite'))}, server: { host: ${JSON.stringify(HOST)}, port: ${port}, strictPort: true, open: false } };\n`);
    return { spec: { cmd: process.execPath, args: [pkgBin('vite', 'vite'), '--config', config] }, crawl: true, script: `/${entry}`, channel: { kind: 'ws', protocol: 'vite-hmr', token: true, hit: (m) => ['update', 'full-reload'].includes(m.type) } };
  },
  webpack: ({ entry, root, dir, port, meta }) => ({ spec: { cmd: process.execPath, args: [pkgBin('webpack-cli', 'webpack-cli'), 'serve', '--config', webpackLike({ entry, root, dir, port, meta, rules: swc(createRequireSwc(), meta) })] }, script: '/bundle.js', channel: { kind: 'ws', path: '/ws', hit: (m) => ['ok', 'warnings', 'static-changed'].includes(m.type) } }),
  rspack: ({ entry, root, dir, port, meta }) => ({ spec: { cmd: process.execPath, args: [pkgBin('@rspack/cli', 'rspack'), 'serve', '--config', webpackLike({ entry, root, dir, port, meta, rules: swc('builtin:swc-loader', meta, ", type: 'javascript/auto'") })] }, script: '/bundle.js', channel: { kind: 'ws', path: '/ws', hit: (m) => ['ok', 'warnings', 'static-changed'].includes(m.type) } }),
  parcel2: ({ dir, port }) => ({ spec: { cmd: process.execPath, args: [join(here, 'node_modules/parcel2/lib/bin.js'), 'serve', 'index.html', '--port', String(port), '--host', HOST, '--cache-dir', join(dir, '.parcel-cache'), '--dist-dir', join(dir, 'dist'), '--no-autoinstall', '--log-level', 'error'] }, script: null, channel: { kind: 'ws', path: '/', hit: (m) => m.type === 'update' || m.type === 'reload' } }),
  parcel3: ({ dir, port }) => ({ spec: { cmd: parcel3Binary(), args: ['serve', 'index.html', '--port', String(port), '--host', HOST, '--dist-dir', join(dir, 'dist'), '--log-level', 'error'] }, script: null, channel: { kind: 'ws', path: '/', hit: (m) => m.type === 'update' || m.type === 'reload' } }),
};
import { createRequire } from 'node:module';
function createRequireSwc() {
  return createRequire(join(here, 'package.json')).resolve('swc-loader');
}
export const noDevServer = { rolldown: 'no development server (the rolldown command line has none)', rollup: 'no development server' };

const fetchText = async (port, path) => {
  const r = await fetch(`http://${HOST}:${port}${path}`);
  const body = await r.text();
  return { status: r.status, body, type: r.headers.get('content-type') ?? '' };
};
// Ask for the page, then for each script and each module they import, six at a time. Returns how many files were fetched.
const loadPage = async (port, script, crawl, ready, timeoutMs, running) => {
  const end = hr() + timeoutMs;
  let lastError = '';
  for (;;) {
    if (running.code !== undefined && running.code !== null) throw new Error(`the server exited (${running.code}): ${running.err.trim().split('\n').slice(-2).join(' | ').slice(0, 160)}`);
    if (hr() > end) throw new Error(`no page within ${timeoutMs / 1000} s: ${lastError.slice(0, 120)} ${running.err.trim().split('\n').slice(-1)[0]?.slice(0, 120) ?? ''}`);
    try {
      const page = await fetchText(port, '/');
      // Pack listens before its first build has finished, and until then the page still names the source file.
      if (page.status !== 200 || (ready && !ready(page.body))) {
        await sleep(5);
        continue;
      }
      let level = script ? [script] : [...page.body.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
      const seen = new Set(level);
      let fetched = 1;
      // One level of the import graph at a time, six requests at a time.
      while (level.length) {
        const next = [];
        let at = 0;
        await Promise.all(
          Array.from({ length: Math.min(6, level.length) }, async () => {
            while (at < level.length) {
              const url = level[at++];
              const r = await fetchText(port, url);
              if (r.status !== 200) throw new Error(`${url}: ${r.status}`);
              fetched++;
              if (!crawl || !/javascript|ecmascript/.test(r.type)) continue;
              // Static imports and re-exports at the start of a statement, as a browser would follow them (not text inside comments or strings).
              for (const m of r.body.matchAll(/^[ \t]*(?:import|export)\b[^;'"]*?(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']|^[ \t]*import\s*["']([^"']+)["']/gm)) {
                const spec = m[1] ?? m[2];
                if (!/^(\/|\.\.?\/)/.test(spec) || /^\/\//.test(spec)) continue;
                const target = new URL(spec, `http://${HOST}${url.startsWith('/') ? '' : '/'}${url}`);
                const path = target.pathname + target.search;
                if (!seen.has(path)) (seen.add(path), next.push(path));
              }
            }
          }),
        );
        level = next;
      }
      return fetched;
    } catch (e) {
      lastError = String(e.message ?? e);
      await sleep(5);
    }
  }
};

// Listen on the tool's channel; `events` collects { at, message }.
const listen = async (port, channel, events) => {
  if (channel.kind === 'sse') {
    const res = await fetch(`http://${HOST}:${port}${channel.path}`, { headers: { accept: 'text/event-stream' } });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    (async () => {
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true }));
        if (done) return;
        buffer += decoder.decode(value);
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const name = block.match(/^event:\s*(.*)$/m)?.[1];
          const data = block.match(/^data:\s*(.*)$/m)?.[1];
          let message = {};
          try {
            message = JSON.parse(data ?? '{}');
          } catch {}
          events.push({ at: hr(), message: { ...message, event: name } });
        }
      }
    })();
    return () => reader.cancel().catch(() => {});
  }
  let query = '';
  if (channel.token) {
    const client = await fetchText(port, '/@vite/client');
    const token = client.body.match(/wsToken\s*=\s*["']([^"']+)["']/)?.[1];
    if (token) query = `?token=${token}`;
  }
  const ws = new WebSocket(`ws://${HOST}:${port}${channel.path ?? '/'}${query}`, channel.protocol);
  ws.onmessage = (e) => {
    try {
      events.push({ at: hr(), message: JSON.parse(e.data) });
    } catch {}
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('the update channel did not open'));
  });
  return () => ws.close();
};

let portCounter = 5200;
const html = (meta, entry, tool) => {
  const src = tool === 'esbuild' ? `/out/${basename(entry, extname(entry))}.js` : tool === 'webpack' || tool === 'rspack' ? '/bundle.js' : tool.startsWith('parcel') ? `./${entry}` : `/${entry}`;
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>bench</title></head><body><div id="app"></div>\n<script ${tool === 'webpack' || tool === 'rspack' ? '' : 'type="module" '}src="${src}"></script>\n</body></html>\n`;
};

// opts: tool, name, meta, workDir, runs, edits
export const measureDev = async ({ tool, name, meta, workDir, runs = 7, edits = 7, settleMs = 600, readyMs = 120000, editMs = 30000 }) => {
  const key = `${name}-dev-${tool}`;
  const proj = join(workDir, 'dev', key);
  const dir = join(workDir, 'dev-out', key);
  const result = { start: [], hmr: [], hmrType: null, files: null, rss: null, failed: null };
  copyProject(meta, proj);
  // Parcel reads its settings from package.json. The build's `targets` would make it build for Node, so the page gets none of them, but the resolver setting
  // the build uses (conditional `exports` of packages, which preact, solid, svelte and the workspace packages need) is the same here.
  if (tool.startsWith('parcel')) writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'bench-dev', private: true, '@parcel/resolver-default': { packageExports: true } }) + '\n');
  writeFileSync(join(proj, 'index.html'), html(meta, meta.entry, tool));
  const editFile = join(proj, meta.edit);
  const untouched = readFileSync(editFile, 'utf8');
  // The module that is changed already takes its own update before the server starts (as a framework's plugin would make it), so the first change
  // is not the one that adds the boundary.
  const original = `${untouched}\n${accept[tool]}\n`;
  writeFileSync(editFile, original);
  try {
    for (let i = -1; i < runs; i++) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const port = portCounter++;
      const d = devTools[tool]({ entry: meta.entry, root: proj, dir, port, meta });
      const t0 = hr();
      const running = new Running(d.spec, { cwd: proj });
      let stop;
      try {
        result.files = await loadPage(port, d.script, d.crawl, d.ready, readyMs, running);
        const ready = hr() - t0;
        running.sample();
        if (i >= 0) (result.start.push(ready), (result.rss = Math.max(result.rss ?? 0, running.maxOne / 1024)));
        // HMR on the first measured instance.
        if (i === 0) {
          const events = [];
          stop = await listen(port, d.channel, events);
          await sleep(settleMs);
          for (let k = 1; k <= edits; k++) {
            const n = 4242000 + k;
            const t = hr();
            events.length = 0;
            writeFileSync(editFile, `${original}globalThis.__rkEdit = ${n};\n`);
            let hit = null;
            while (hr() - t < editMs && !hit) {
              hit = events.find((e) => e.at >= t && d.channel.hit(e.message));
              if (!hit) await sleep(1);
            }
            if (!hit) {
              // What the tool reported instead (webpack and rspack send the compile errors and warnings over the same channel).
              const said = (events.find((e) => e.message.type === 'errors') ?? events.find((e) => e.message.type === 'warnings'))?.message.data?.[0];
              const text = typeof said === 'string' ? said : said?.message;
              result.hmrFailed = `edit ${k}: no update notice within ${editMs / 1000} s${events.length ? ` (saw ${[...new Set(events.map((e) => e.message.type ?? e.message.event))].join(', ')}${text ? `: ${text.replace(/\s+/g, ' ').slice(0, 200)}` : ''})` : ''}`;
              break;
            }
            result.hmr.push(hit.at - t);
            result.hmrType = hit.message.type ?? hit.message.event ?? null;
            await sleep(settleMs);
          }
        }
      } finally {
        stop?.();
        const left = await running.stop();
        if (left.length) result.leftover = left;
      }
    }
  } catch (e) {
    result.failed = String(e.message ?? e);
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
  if (result.start.length) Object.assign(result, { startMed: median(result.start), startMin: Math.min(...result.start) });
  if (result.hmr.length) Object.assign(result, { hmrMed: median(result.hmr), hmrMin: Math.min(...result.hmr) });
  return result;
};
