// Writes the generated workloads: a 1,500-module JavaScript app, a 500-module TypeScript app, a monorepo-style TypeScript app
// (workspace packages linked through node_modules), and the Svelte app (inputs/svelteapp) compiled to server code.
// They are made, not stored, so the repository stays small and anyone can see what they contain.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, 'inputs', 'generated');
rmSync(root, { recursive: true, force: true });

// Plain JavaScript: 1,500 modules of 40 small exported functions, each importing a few later ones.
const js = join(root, 'app1500');
mkdirSync(js, { recursive: true });
const n = 1500;
for (let i = 0; i < n; i++) {
  let body = '';
  for (let k = 0; k < 40; k++) body += `export function f${i}_${k}(a) { return a * ${k} + ${i}; }\n`;
  let deps = '';
  const used = [];
  for (let j = i + 1; j < Math.min(n, i + 4); j++) {
    deps += `import { f${j}_1 } from './m${j}.js';\n`;
    used.push(`f${j}_1(${i})`);
  }
  writeFileSync(join(js, `m${i}.js`), `${deps}${body}export const v${i} = ${used.join(' + ') || '0'};\n`);
}
writeFileSync(join(js, 'main.js'), "import { v0 } from './m0.js';\nconsole.log(v0);\n");

// TypeScript: 500 modules with an enum, an interface, a generic method, a getter and parameter properties.
const ts = join(root, 'tsapp500');
mkdirSync(ts, { recursive: true });
const m = 500;
for (let i = 0; i < m; i++) {
  let deps = '';
  const used = [];
  for (let j = i + 1; j < Math.min(m, i + 3); j++) {
    deps += `import { Thing${j}, make${j}, Kind${j} } from './m${j}';\n`;
    used.push(`make${j}(${i}).size`);
  }
  writeFileSync(
    join(ts, `m${i}.ts`),
    `${deps}export enum Kind${i} { A, B = ${i}, C }
export interface Props${i} { id: number; name: string; kind: Kind${i}; tags?: readonly string[] }
export class Thing${i} implements Props${i} {
  constructor(public id: number, public name: string, public kind: Kind${i} = Kind${i}.B, readonly tags: string[] = []) {}
  describe<T extends object>(extra: T): string { return \`\${this.name}#\${this.id}:\${Kind${i}[this.kind]}:\${JSON.stringify(extra)}\`; }
  get size(): number { return this.tags.length + ${i}; }
}
export function make${i}(id: number): Thing${i} { return new Thing${i}(id, 'thing${i}', Kind${i}.C, ['x', 'y']); }
export type Maker${i} = typeof make${i};
export const total${i}: number = ${used.join(' + ') || '0'} + ${i};
`,
  );
}
// For the type-check table only: it sits next to the app, not in it, so no bundler picks it up when it builds the app.
writeFileSync(join(root, 'tsapp500-check.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, isolatedModules: true, skipLibCheck: true, lib: ['ES2022', 'DOM'], types: [] }, include: ['./tsapp500/*.ts'] }, null, 2) + '\n');
writeFileSync(join(ts, 'main.ts'), "import { total0, make0 } from './m0';\nconsole.log(total0, make0(1).describe({ ok: true }));\n");

// A monorepo-style TypeScript app: four workspace packages (utils < model < data < ui) and one app. The packages are linked
// into node_modules/@mono the way a package manager links a workspace, and each package's `exports` names its TypeScript source,
// so a bundler has to resolve through a symlink and the package's exports to a .ts file that is outside node_modules once resolved.
const mono = join(root, 'monorepo');
const packages = ['utils', 'model', 'data', 'ui'];
const perPackage = 60;
const cap = (x) => x[0].toUpperCase() + x.slice(1);
mkdirSync(join(mono, 'node_modules', '@mono'), { recursive: true });
writeFileSync(join(mono, 'package.json'), JSON.stringify({ name: 'mono-root', private: true, type: 'module' }, null, 2) + '\n');
writeFileSync(
  join(mono, 'tsconfig.json'),
  JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, isolatedModules: true, skipLibCheck: true, lib: ['ES2022', 'DOM'], types: [] }, include: ['packages/*/src', 'apps/*/src'] }, null, 2) + '\n',
);
packages.forEach((pkg, level) => {
  const dir = join(mono, 'packages', pkg, 'src');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(mono, 'packages', pkg, 'package.json'), JSON.stringify({ name: `@mono/${pkg}`, version: '1.0.0', type: 'module', exports: { '.': './src/index.ts' } }, null, 2) + '\n');
  symlinkSync(join('..', '..', 'packages', pkg), join(mono, 'node_modules', '@mono', pkg), 'dir');
  const P = cap(pkg);
  let index = '';
  for (let i = 0; i < perPackage; i++) {
    const lower = level > 0 ? packages[level - 1] : null;
    const imports = [];
    const uses = [];
    for (let j = i + 1; j < Math.min(perPackage, i + 3); j++) {
      imports.push(`import { make${P}${j} } from './m${j}';`);
      uses.push(`make${P}${j}`);
    }
    if (lower) {
      imports.push(`import { make${cap(lower)}${i}, Store${cap(lower)}${i} } from '@mono/${lower}';`);
      uses.push(`make${cap(lower)}${i}`, `Store${cap(lower)}${i}`);
    }
    writeFileSync(
      join(dir, `m${i}.ts`),
      `${imports.join('\n')}${imports.length ? '\n' : ''}export interface Rec${P}${i} { readonly id: number; label: string; meta: { n: number; tags: readonly string[] } }
export class Store${P}${i}<T extends Rec${P}${i} = Rec${P}${i}> {
  private items = new Map<number, T>();
  add(item: T): this { this.items.set(item.id, item); return this; }
  find(id: number): T | undefined { return this.items.get(id); }
  map<U>(f: (item: T) => U): U[] { return [...this.items.values()].map(f); }
  get size(): number { return this.items.size; }
}
export function make${P}${i}(id: number): Rec${P}${i} { return { id, label: \`${pkg}-${i}-\${id}\`, meta: { n: id + ${i}, tags: ['${pkg}', ...([${uses.join(', ')}] as { name: string }[]).map((f) => f.name)] } }; }
export type Maker${P}${i} = typeof make${P}${i};
`,
    );
    index += `export * from './m${i}';\n`;
  }
  writeFileSync(join(dir, 'index.ts'), index);
});
const appDir = join(mono, 'apps', 'web', 'src');
mkdirSync(appDir, { recursive: true });
writeFileSync(join(mono, 'apps', 'web', 'package.json'), JSON.stringify({ name: '@mono/web', version: '1.0.0', private: true, type: 'module' }, null, 2) + '\n');
const picks = Array.from({ length: 12 }, (_, i) => i * 3);
writeFileSync(
  join(appDir, 'main.ts'),
  `${picks.map((i) => `import { makeUi${i}, StoreUi${i} } from '@mono/ui';`).join('\n')}
import { makeData5 } from '@mono/data';
${picks.map((i) => `const s${i} = new StoreUi${i}().add(makeUi${i}(${i}));`).join('\n')}
const total: number = ${picks.map((i) => `s${i}.size + makeUi${i}(${i}).meta.n`).join(' + ')};
console.log(total, makeData5(1).label);
`,
);
// The Svelte components of inputs/svelteapp, compiled to server code (the compiler is Svelte's own, from the image's node_modules).
const { compile } = await import('svelte/compiler');
const svelteOut = join(root, 'svelteapp');
mkdirSync(svelteOut, { recursive: true });
for (const file of readdirSync(join(here, 'inputs', 'svelteapp')).filter((f) => f.endsWith('.svelte'))) {
  const source = readFileSync(join(here, 'inputs', 'svelteapp', file), 'utf8');
  const { js } = compile(source, { filename: file, generate: 'server', css: 'injected', dev: false });
  writeFileSync(join(svelteOut, file.replace(/\.svelte$/, '.js')), js.code.replace(/\.svelte(['"])/g, '.js$1'));
}
console.log(`wrote ${n} + ${m} modules, the monorepo and the Svelte app under ${root}`);
