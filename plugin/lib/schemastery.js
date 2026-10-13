/**
 * Load the harness-shipped schemastery module.
 *
 * A profile-installed bundle is reached through a symlink in the profile's
 * `node_modules`, and Node resolves its imports from the link's *realpath*
 * (the workspace), so `import '@deepseek-ai/schemastery'` fails there. The
 * module itself lives inside the running installation, which this process can
 * import directly; the bare specifier stays as a fallback for other layouts.
 *
 * Returning undefined is a supported outcome: the plugin then declares no
 * `Config`, keeps its own validation, and simply offers no settings form.
 * @module dsh-local-compute-pool/schemastery
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @returns the candidate module specifiers, most specific first. */
function candidates() {
  const list = [];
  const override = process.env.DSH_SCHEMASTERY_PATH;
  if (typeof override === 'string' && override.length > 0) list.push(pathToFileURL(override).href);
  const resources = process.resourcesPath;
  if (typeof resources === 'string' && resources.length > 0) {
    const relative = join('dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs');
    list.push(pathToFileURL(join(resources, 'app.asar', relative)).href);
    list.push(pathToFileURL(join(resources, 'app.asar.unpacked', relative)).href);
  }
  list.push('@deepseek-ai/schemastery');
  return list;
}

/**
 * Import schemastery, or report that this deployment cannot reach it.
 * @returns the schemastery `Schema` factory (its default export), or undefined.
 */
export async function loadSchemastery() {
  for (const specifier of candidates()) {
    try {
      const module = await import(specifier);
      const schema = module?.default ?? module;
      if (typeof schema?.object === 'function' && typeof schema?.boolean === 'function') return schema;
    } catch {
      // Try the next route; the caller falls back to a Config-less plugin.
    }
  }
  return undefined;
}
