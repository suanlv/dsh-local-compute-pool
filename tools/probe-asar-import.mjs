/**
 * Runtime probe: can Electron's Node `import()` a module that lives inside
 * app.asar?
 *
 * This is the question the plugin's `lib/schemastery.js` depends on: the
 * harness-shipped schemastery sits inside `app.asar`, the profile's
 * `node_modules` does not carry it, so the `resourcesPath` route is the only one
 * that can work. Plain Node has no asar support and reports
 * `ERR_MODULE_NOT_FOUND` — which is why the plugin's `Config` (and with it the
 * settings page) can appear missing when checked with the wrong runtime.
 *
 * Usage:
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & "<install>\DeepSeek Harness.exe" tools\probe-asar-import.mjs [--resources <dir>]
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const argOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
};

const candidates = [
  argOf('--resources') ?? process.env.DSH_RESOURCES,
  typeof process.resourcesPath === 'string' ? process.resourcesPath : undefined,
  process.platform === 'win32' && process.env.LOCALAPPDATA !== undefined
    ? join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources')
    : undefined,
].filter((candidate) => typeof candidate === 'string' && candidate !== '');

const resources = candidates.find((candidate) => existsSync(join(candidate, 'app.asar')));
if (resources === undefined) {
  console.error('Cannot find the DeepSeek Harness installation.');
  console.error('Pass --resources <install>/resources or set DSH_RESOURCES.');
  process.exitCode = 2;
  process.exit();
}

const rel = join('dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs');
const asarPath = join(resources, 'app.asar', rel);

console.log('runtime          :', process.versions.node, '| electron:', process.versions.electron ?? 'none (plain node)');
console.log('resources        :', resources);
console.log('fs.statSync(asar):', (() => {
  try {
    return `${statSync(asarPath).size} bytes  → the asar layer is readable`;
  } catch (error) {
    return `${error.code}  → this runtime cannot see inside app.asar`;
  }
})());

for (const [label, specifier] of [
  ['asar (resourcesPath route)', pathToFileURL(asarPath).href],
  ['bare @deepseek-ai/schemastery', '@deepseek-ai/schemastery'],
]) {
  try {
    const loaded = await import(specifier);
    const schema = loaded?.default ?? loaded;
    console.log(`ok    ${label}: object=${typeof schema?.object} boolean=${typeof schema?.boolean}`);
  } catch (error) {
    console.log(`FAIL  ${label}: ${error.code ?? error.name} ${String(error.message).split('\n')[0].slice(0, 100)}`);
  }
}
