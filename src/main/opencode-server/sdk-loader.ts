// src/main/opencode-server/sdk-loader.ts

/**
 * Runtime loader for the ESM-only `@opencode-ai/sdk`.
 *
 * The Electron main process is compiled to CommonJS (`tsconfig.main.json` uses
 * `module: CommonJS`). A static `import`/`require` of the SDK throws
 * `ERR_REQUIRE_ESM`, and tsc downlevels a plain `await import(...)` to
 * `require(...)` - which hits the same wall. Wrapping the dynamic import in an
 * indirect `Function` call keeps a *native* `import()` in the emitted output, so
 * the ESM module loads correctly at runtime. Types still come from the package
 * via `import type`, resolved through the `paths` mapping in tsconfig.main.json.
 */

import type * as OpencodeSdk from '@opencode-ai/sdk';

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
	specifier: string
) => Promise<typeof OpencodeSdk>;

let cached: Promise<typeof OpencodeSdk> | null = null;

/** Load the OpenCode SDK once and cache the module namespace. */
export function loadOpencodeSdk(): Promise<typeof OpencodeSdk> {
	if (!cached) {
		cached = dynamicImport('@opencode-ai/sdk');
	}
	return cached;
}
