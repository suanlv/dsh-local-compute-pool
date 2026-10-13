/**
 * Post-install self check: pretend to be the profile loader for one pass.
 *
 * Verifies, against the *installed* copy (through the profile's junction, not
 * the repository path):
 *   1. the bundle is registered under its package name;
 *   2. `import('<package>')` resolves through the profile and exports the identity;
 *   3. the declared `Config` schema builds (settings namespace available);
 *   4. the locale files use the `meta` envelope the harness actually reads;
 *   5. the bundle patch mounts index.js and carries the row id;
 *   6. `apply()` wires the route waterfall, the admission gate and the tool.
 *
 * Run it with the host's own runtime, so that app.asar resolution is real:
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & "<install>\DeepSeek Harness.exe" tools\verify-install.mjs
 * Plain `node tools\verify-install.mjs` also runs, but then the `Config` check
 * reports FAIL: plain Node has no asar support, so the resourcesPath route
 * cannot be imported. That is a limitation of the checker, not of the plugin.
 *
 * Nothing here is hard-coded to one machine: the harness location is discovered
 * (or given), and the profile directory defaults to `~/.dsh/profiles/<profile>`.
 *
 * Usage:
 *   node tools/verify-install.mjs [--profile <name>] [--resources <dir>]
 *   DSH_RESOURCES=<install>\resources  DSH_PROFILE=desktop
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const argOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
};

const PLUGIN = resolve(import.meta.dirname, '..', 'plugin');
const PACKAGE = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));

/** @returns candidate `resources` directories of a DeepSeek Harness install. */
function resourcesCandidates() {
  const explicit = argOf('--resources') ?? process.env.DSH_RESOURCES;
  const list = [];
  if (explicit !== undefined && explicit !== '') list.push(explicit);
  // Electron defines this when the checker runs under the host's own runtime.
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') list.push(process.resourcesPath);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA !== undefined) {
    list.push(join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources'));
  } else if (process.platform === 'darwin') {
    list.push('/Applications/DeepSeek Harness.app/Contents/Resources');
  } else {
    list.push('/opt/DeepSeek Harness/resources', '/usr/lib/deepseek-harness/resources');
  }
  return list;
}

const resources = resourcesCandidates().find((candidate) => existsSync(join(candidate, 'app.asar')));
if (resources === undefined) {
  console.error('Cannot find the DeepSeek Harness installation.');
  console.error('Pass --resources <install>/resources or set DSH_RESOURCES.');
  process.exitCode = 2;
  process.exit();
}
if (typeof process.resourcesPath !== 'string' || process.resourcesPath === '') {
  // Plain Node: hand the discovery result to the plugin's schemastery loader.
  process.resourcesPath = resources;
}

const profileName = argOf('--profile') ?? process.env.DSH_PROFILE ?? 'desktop';
const profileDir = join(homedir(), '.dsh', 'profiles', profileName);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`);
};

console.log(`plugin:   ${PLUGIN}`);
console.log(`profile:  ${profileDir}`);
console.log(`harness:  ${resources}\n`);

// 1. registration -----------------------------------------------------------
let profile = { dsh: { profile: { bundles: [] } }, dependencies: {} };
if (existsSync(join(profileDir, 'package.json'))) {
  profile = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
}
const bundles = profile.dsh?.profile?.bundles ?? [];
check(`profile lists ${PACKAGE.name}`, bundles.includes(PACKAGE.name));
check('dependency spec points at a directory', typeof profile.dependencies?.[PACKAGE.name] === 'string');

// 2. host half through the profile's junction -------------------------------
const installed = join(profileDir, 'node_modules', PACKAGE.name);
check('installed entry exists', existsSync(join(installed, 'index.js')));
// The bundle patch is the single source of truth for the row id, which is also
// the settings namespace the client half has to follow.
const patchText = readFileSync(join(installed, 'cordis.patch.yml'), 'utf8');
const rowId = /^\s*-\s*id:\s*(\S+)\s*$/m.exec(patchText)?.[1];
const url = pathToFileURL(join(installed, 'index.js')).href;
let mod;
try {
  mod = await import(url);
} catch (error) {
  check('import the installed entry', false, String(error?.message ?? error).split('\n')[0]);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  process.exitCode = 1;
  process.exit();
}
check('exported name equals the patch row id', rowId !== undefined && mod.name === rowId, `name=${mod.name}`);
check('injects llm', Array.isArray(mod.inject) && mod.inject.includes('llm'));
check('declares a Config schema (settings namespace)', mod.Config !== undefined,
  mod.Config === undefined ? 'plain Node cannot read app.asar — rerun with ELECTRON_RUN_AS_NODE=1' : '');

// 3. client half: identity constants in the shipped file --------------------
const client = readFileSync(join(installed, 'client.js'), 'utf8');
check('client loader id equals the package name', client.includes(`id: '${PACKAGE.name}'`));
check('client bundle key equals the package name', client.includes(`const BUNDLE_KEY = '${PACKAGE.name}'`));
check('client entry id equals the patch row id', rowId !== undefined && client.includes(`const ENTRY_ID = '${rowId}'`),
  `row id=${rowId}`);
check('patch mounts ./index.js', patchText.includes("name: './index.js'"));

// 4. locale metadata envelope ----------------------------------------------
for (const lang of ['zh', 'en']) {
  const file = join(installed, 'locale', `${lang}.json`);
  const doc = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  check(`${lang}.json uses the meta envelope`, typeof doc?.meta?.title === 'string' && doc.meta.title.length > 0,
    doc?.meta?.title);
}

// 5. wiring with a fake context --------------------------------------------
const listeners = new Map();
const tools = [];
const ctx = {
  logger: { info: () => {}, warn: () => {}, debug: () => {} },
  on(event, handler) {
    const list = listeners.get(event) ?? [];
    list.push(handler);
    listeners.set(event, list);
    return () => {};
  },
  inject(names, fn) {
    if (names.includes('tools')) fn({ tools: { register: (definition) => tools.push(definition) } });
    return () => {};
  },
  get(id) {
    if (id === 'llm') {
      return {
        listProviders: () => [{ id: 'local' }],
        listModels: async () => [{ id: 'probe-model' }],
      };
    }
    return undefined;
  },
  effect: () => () => {},
};
let applied = true;
try {
  mod.apply(ctx, { endpoints: [{ id: 'probe', provider: 'local', model: 'auto' }], triggers: [] });
} catch (error) {
  applied = false;
  check('apply() accepts a minimal configuration', false, String(error?.message ?? error).split('\n')[0]);
}
if (applied) {
  await new Promise((resolve) => setImmediate(resolve));
  check('apply() wired both waterfalls', listeners.has('llm/stream') && listeners.has('agent/request'));
  check('apply() listens for live configuration', listeners.has('loader/volatile-update'));
  check('status tool registered', tools.some((tool) => tool.name === 'local_pool'),
    `tools=${tools.map((tool) => tool.name).join(',') || 'none'}`);
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
