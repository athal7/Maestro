// src/main/opencode-server/OpencodeServerManager.ts

/**
 * Owns the long-lived `opencode serve` process(es) that back the SDK execution
 * path, and the SDK client bound to each.
 *
 * OpenCode's server is project-scoped via a `directory` query param on every
 * request, so a single server process serves every Maestro workspace - we key
 * instances by the resolved binary path (a user could point different agents at
 * different opencode builds; almost always there's just one). The server is
 * spawned lazily on first prompt and torn down on app shutdown.
 *
 * We deliberately spawn the server ourselves instead of using the SDK's
 * `createOpencodeServer`, because that helper hardcodes the `opencode` binary on
 * PATH and Maestro must honor the user's resolved/custom binary and its spawn
 * environment (version-manager PATH, shell env vars, etc.).
 */

import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { loadOpencodeSdk } from './sdk-loader';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { buildChildProcessEnv } from '../process-manager/utils/envBuilder';

/**
 * Auto-approve every tool. This mirrors the CLI path's `OPENCODE_CONFIG_CONTENT`
 * so the SDK migration is behavior-preserving: no permission prompts today. When
 * the permission-bubbling feature lands, this becomes per-tool `ask` and the
 * `permission.updated` SSE events get surfaced to the renderer.
 */
const AUTO_APPROVE_CONFIG = {
	permission: { '*': 'allow', external_directory: 'allow', question: 'deny' },
	tools: { question: false },
} as const;

/** How long to wait for the server to print its readiness line before failing. */
const SERVER_START_TIMEOUT_MS = 15000;

export interface OpencodeServerHandle {
	url: string;
	client: OpencodeClient;
}

interface ServerInstance extends OpencodeServerHandle {
	process: ChildProcess;
}

export interface EnsureServerOptions {
	/** Resolved opencode binary path (ProcessConfig.command). */
	binaryPath: string;
	/** Session-level custom env vars (ProcessConfig.customEnvVars). */
	customEnvVars?: Record<string, string>;
	/** Global shell env vars (ProcessConfig.shellEnvVars). */
	shellEnvVars?: Record<string, string>;
	/** Extra PATH dirs (ProcessConfig.extraPathDirs). */
	extraPathDirs?: string[];
	/** Working directory to spawn the server in (any workspace; requests are
	 *  scoped per-call via `directory`). */
	cwd: string;
}

class OpencodeServerManager {
	/** Ready server instances, keyed by resolved binary path. */
	private servers = new Map<string, ServerInstance>();
	/** In-flight startups, keyed by binary path, to dedupe concurrent spawns. */
	private starting = new Map<string, Promise<OpencodeServerHandle>>();

	/**
	 * Ensure a server for the given binary is running and return its client.
	 * Concurrent callers for the same binary share a single startup.
	 */
	async ensureServer(opts: EnsureServerOptions): Promise<OpencodeServerHandle> {
		const key = opts.binaryPath;

		const existing = this.servers.get(key);
		if (existing) return { url: existing.url, client: existing.client };

		const inFlight = this.starting.get(key);
		if (inFlight) return inFlight;

		const startup = this.startServer(opts)
			.then((instance) => {
				this.servers.set(key, instance);
				this.starting.delete(key);
				return { url: instance.url, client: instance.client };
			})
			.catch((err) => {
				this.starting.delete(key);
				throw err;
			});

		this.starting.set(key, startup);
		return startup;
	}

	private async startServer(opts: EnsureServerOptions): Promise<ServerInstance> {
		const port = await findFreePort();
		const hostname = '127.0.0.1';
		const env = buildChildProcessEnv(
			opts.customEnvVars,
			false,
			opts.shellEnvVars,
			opts.extraPathDirs
		);
		env.OPENCODE_CONFIG_CONTENT = JSON.stringify(AUTO_APPROVE_CONFIG);

		logger.info('[OpencodeServer] Starting shared server', 'OpencodeServer', {
			binaryPath: opts.binaryPath,
			hostname,
			port,
			cwd: opts.cwd,
		});

		const child = spawn(opts.binaryPath, ['serve', `--hostname=${hostname}`, `--port=${port}`], {
			cwd: opts.cwd,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		const url = await this.awaitReadiness(child, port, hostname);

		// Once ready, drop the cached instance if the server ever exits so the next
		// prompt re-spawns a fresh one instead of hitting a dead socket.
		child.on('exit', (code, signal) => {
			logger.warn('[OpencodeServer] Server process exited', 'OpencodeServer', {
				binaryPath: opts.binaryPath,
				code,
				signal,
			});
			const current = this.servers.get(opts.binaryPath);
			if (current?.process === child) {
				this.servers.delete(opts.binaryPath);
			}
		});

		const { createOpencodeClient } = await loadOpencodeSdk();
		const client = createOpencodeClient({ baseUrl: url });
		logger.info('[OpencodeServer] Server ready', 'OpencodeServer', { url });
		return { url, client, process: child };
	}

	/**
	 * Resolve when the server prints `opencode server listening on <url>`, or
	 * reject on early exit / timeout. Mirrors the SDK's readiness detection.
	 */
	private awaitReadiness(child: ChildProcess, port: number, hostname: string): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			let output = '';
			let settled = false;

			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				fn();
			};

			const timer = setTimeout(() => {
				finish(() => {
					try {
						child.kill();
					} catch {
						// already dead
					}
					reject(
						new Error(
							`Timed out after ${SERVER_START_TIMEOUT_MS}ms waiting for opencode server.` +
								(output.trim() ? `\nOutput: ${output.slice(-2000)}` : '')
						)
					);
				});
			}, SERVER_START_TIMEOUT_MS);

			child.stdout?.setEncoding('utf8');
			child.stdout?.on('data', (chunk: string) => {
				output += chunk;
				for (const line of output.split('\n')) {
					if (line.startsWith('opencode server listening')) {
						const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
						// Fall back to the port we requested if the banner format changes.
						finish(() => resolve(match?.[1] ?? `http://${hostname}:${port}`));
						return;
					}
				}
			});
			child.stderr?.setEncoding('utf8');
			child.stderr?.on('data', (chunk: string) => {
				output += chunk;
			});

			child.on('error', (err) => finish(() => reject(err)));
			child.on('exit', (code) =>
				finish(() =>
					reject(
						new Error(
							`opencode server exited with code ${code} before becoming ready.` +
								(output.trim() ? `\nOutput: ${output.slice(-2000)}` : '')
						)
					)
				)
			);
		});
	}

	/** Kill every running server. Called on app shutdown. */
	shutdown(): void {
		for (const [key, instance] of this.servers) {
			try {
				instance.process.kill();
			} catch (err) {
				void captureException(err);
			}
			this.servers.delete(key);
		}
		this.starting.clear();
	}
}

/** Find an available ephemeral TCP port on the loopback interface. */
function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			if (addr && typeof addr === 'object') {
				const { port } = addr;
				srv.close(() => resolve(port));
			} else {
				srv.close(() => reject(new Error('Failed to acquire a free port')));
			}
		});
	});
}

/** Process-wide singleton. */
export const opencodeServerManager = new OpencodeServerManager();
