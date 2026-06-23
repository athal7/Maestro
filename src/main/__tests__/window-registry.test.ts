/**
 * Tests for WindowRegistry - the single source of truth for window<->session
 * ownership. The registry only tracks BrowserWindows it is handed, so these
 * tests pass minimal fake BrowserWindow objects (just the methods the registry
 * calls: getBounds / isDestroyed).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';
import { WindowRegistry, type WindowRegistryChange } from '../window-registry';

/** A fake BrowserWindow exposing only what the registry touches. */
function makeWindow(
	bounds: { x: number; y: number; width: number; height: number } = {
		x: 0,
		y: 0,
		width: 800,
		height: 600,
	},
	destroyed = false
): BrowserWindow {
	return {
		getBounds: vi.fn(() => bounds),
		isDestroyed: vi.fn(() => destroyed),
	} as unknown as BrowserWindow;
}

describe('WindowRegistry', () => {
	let registry: WindowRegistry;

	beforeEach(() => {
		registry = new WindowRegistry();
	});

	describe('create / get / remove', () => {
		it('registers a window with the supplied ID and defaults', () => {
			const bw = makeWindow();
			const id = registry.create({ windowId: 'w1', browserWindow: bw });

			expect(id).toBe('w1');
			const entry = registry.get('w1');
			expect(entry).toBeDefined();
			expect(entry?.id).toBe('w1');
			expect(entry?.browserWindow).toBe(bw);
			expect(entry?.sessionIds).toEqual([]);
			expect(entry?.isMain).toBe(false);
		});

		it('generates a UUID when no windowId is supplied', () => {
			const id = registry.create({ browserWindow: makeWindow() });
			expect(id).toMatch(/^[0-9a-f-]{36}$/);
			expect(registry.get(id)).toBeDefined();
		});

		it('copies sessionIds so external mutation does not leak in', () => {
			const sessions = ['a', 'b'];
			registry.create({ windowId: 'w1', sessionIds: sessions, browserWindow: makeWindow() });
			sessions.push('c');
			expect(registry.get('w1')?.sessionIds).toEqual(['a', 'b']);
		});

		it('getAll returns every registered window', () => {
			registry.create({ windowId: 'w1', browserWindow: makeWindow() });
			registry.create({ windowId: 'w2', browserWindow: makeWindow() });
			expect(registry.getAll().map((w) => w.id)).toEqual(['w1', 'w2']);
		});

		it('remove deletes the window', () => {
			registry.create({ windowId: 'w1', browserWindow: makeWindow() });
			registry.remove('w1');
			expect(registry.get('w1')).toBeUndefined();
			expect(registry.getAll()).toHaveLength(0);
		});

		it('remove is a no-op for an unknown window', () => {
			const listener = vi.fn();
			registry.onChange(listener);
			registry.remove('nope');
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe('getPrimary', () => {
		it('returns the isMain window', () => {
			registry.create({ windowId: 'w1', browserWindow: makeWindow() });
			registry.create({ windowId: 'main', isMain: true, browserWindow: makeWindow() });
			expect(registry.getPrimary()?.id).toBe('main');
		});

		it('returns undefined when no primary is registered', () => {
			registry.create({ windowId: 'w1', browserWindow: makeWindow() });
			expect(registry.getPrimary()).toBeUndefined();
		});
	});

	describe('getWindowForSession', () => {
		it('returns the owning window ID', () => {
			registry.create({ windowId: 'w1', sessionIds: ['s1', 's2'], browserWindow: makeWindow() });
			registry.create({ windowId: 'w2', sessionIds: ['s3'], browserWindow: makeWindow() });
			expect(registry.getWindowForSession('s2')).toBe('w1');
			expect(registry.getWindowForSession('s3')).toBe('w2');
		});

		it('returns null when no window owns the session', () => {
			registry.create({ windowId: 'w1', sessionIds: ['s1'], browserWindow: makeWindow() });
			expect(registry.getWindowForSession('ghost')).toBeNull();
		});
	});

	describe('setSessionsForWindow', () => {
		it('replaces the session list and emits a change', () => {
			const listener = vi.fn();
			registry.create({ windowId: 'w1', sessionIds: ['s1'], browserWindow: makeWindow() });
			registry.onChange(listener);

			registry.setSessionsForWindow('w1', ['s2', 's3']);

			expect(registry.get('w1')?.sessionIds).toEqual(['s2', 's3']);
			expect(listener).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'sessions-changed', windowId: 'w1' })
			);
		});

		it('is a no-op for an unknown window', () => {
			const listener = vi.fn();
			registry.onChange(listener);
			registry.setSessionsForWindow('nope', ['s1']);
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe('moveSession', () => {
		beforeEach(() => {
			registry.create({ windowId: 'w1', sessionIds: ['s1', 's2'], browserWindow: makeWindow() });
			registry.create({ windowId: 'w2', sessionIds: [], browserWindow: makeWindow() });
		});

		it('moves a session between windows', () => {
			registry.moveSession('s1', 'w1', 'w2');
			expect(registry.get('w1')?.sessionIds).toEqual(['s2']);
			expect(registry.get('w2')?.sessionIds).toEqual(['s1']);
			expect(registry.getWindowForSession('s1')).toBe('w2');
		});

		it('does not duplicate a session already in the destination', () => {
			registry.setSessionsForWindow('w2', ['s1']);
			registry.moveSession('s1', 'w1', 'w2');
			expect(registry.get('w2')?.sessionIds).toEqual(['s1']);
		});

		it('emits a session-moved change', () => {
			const listener = vi.fn();
			registry.onChange(listener);
			registry.moveSession('s1', 'w1', 'w2');
			expect(listener).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'session-moved',
					sessionId: 's1',
					fromWindowId: 'w1',
					toWindowId: 'w2',
				})
			);
		});

		it('is a no-op when either window is unknown', () => {
			registry.moveSession('s1', 'w1', 'ghost');
			expect(registry.get('w1')?.sessionIds).toEqual(['s1', 's2']);
		});
	});

	describe('reclaimSessionsToPrimary', () => {
		it('moves every session from a secondary window into the primary', () => {
			registry.create({
				windowId: 'main',
				isMain: true,
				sessionIds: ['m1'],
				browserWindow: makeWindow(),
			});
			registry.create({ windowId: 'w2', sessionIds: ['s1', 's2'], browserWindow: makeWindow() });

			const result = registry.reclaimSessionsToPrimary('w2');

			expect(result).toEqual({ movedSessionIds: ['s1', 's2'], primaryWindowId: 'main' });
			expect(registry.get('main')?.sessionIds).toEqual(['m1', 's1', 's2']);
			expect(registry.get('w2')?.sessionIds).toEqual([]);
			expect(registry.getWindowForSession('s1')).toBe('main');
			expect(registry.getWindowForSession('s2')).toBe('main');
		});

		it('emits a session-moved change per reclaimed session', () => {
			registry.create({ windowId: 'main', isMain: true, browserWindow: makeWindow() });
			registry.create({ windowId: 'w2', sessionIds: ['s1', 's2'], browserWindow: makeWindow() });
			const listener = vi.fn();
			registry.onChange(listener);

			registry.reclaimSessionsToPrimary('w2');

			const moves = listener.mock.calls
				.map((c) => c[0] as WindowRegistryChange)
				.filter((c) => c.type === 'session-moved');
			expect(moves).toEqual([
				expect.objectContaining({ sessionId: 's1', fromWindowId: 'w2', toWindowId: 'main' }),
				expect.objectContaining({ sessionId: 's2', fromWindowId: 'w2', toWindowId: 'main' }),
			]);
		});

		it('returns an empty move list (with the primary id) when the window owns nothing', () => {
			registry.create({ windowId: 'main', isMain: true, browserWindow: makeWindow() });
			registry.create({ windowId: 'w2', sessionIds: [], browserWindow: makeWindow() });

			expect(registry.reclaimSessionsToPrimary('w2')).toEqual({
				movedSessionIds: [],
				primaryWindowId: 'main',
			});
		});

		it('returns null for an unknown window', () => {
			registry.create({ windowId: 'main', isMain: true, browserWindow: makeWindow() });
			expect(registry.reclaimSessionsToPrimary('ghost')).toBeNull();
		});

		it('returns null when asked to reclaim the primary itself', () => {
			registry.create({
				windowId: 'main',
				isMain: true,
				sessionIds: ['m1'],
				browserWindow: makeWindow(),
			});
			expect(registry.reclaimSessionsToPrimary('main')).toBeNull();
			expect(registry.get('main')?.sessionIds).toEqual(['m1']);
		});

		it('returns null when no primary is registered', () => {
			registry.create({ windowId: 'w2', sessionIds: ['s1'], browserWindow: makeWindow() });
			expect(registry.reclaimSessionsToPrimary('w2')).toBeNull();
			expect(registry.get('w2')?.sessionIds).toEqual(['s1']);
		});

		it('does not duplicate a session the primary already owns', () => {
			registry.create({
				windowId: 'main',
				isMain: true,
				sessionIds: ['s1'],
				browserWindow: makeWindow(),
			});
			registry.create({ windowId: 'w2', sessionIds: ['s1', 's2'], browserWindow: makeWindow() });

			registry.reclaimSessionsToPrimary('w2');

			expect(registry.get('main')?.sessionIds).toEqual(['s1', 's2']);
			expect(registry.get('w2')?.sessionIds).toEqual([]);
		});
	});

	describe('findWindowAtPoint', () => {
		it('returns the window whose bounds contain the point', () => {
			registry.create({
				windowId: 'left',
				browserWindow: makeWindow({ x: 0, y: 0, width: 500, height: 500 }),
			});
			registry.create({
				windowId: 'right',
				browserWindow: makeWindow({ x: 600, y: 0, width: 500, height: 500 }),
			});
			expect(registry.findWindowAtPoint(700, 250)).toBe('right');
			expect(registry.findWindowAtPoint(100, 100)).toBe('left');
		});

		it('returns null when the point is outside every window', () => {
			registry.create({
				windowId: 'w1',
				browserWindow: makeWindow({ x: 0, y: 0, width: 100, height: 100 }),
			});
			expect(registry.findWindowAtPoint(5000, 5000)).toBeNull();
		});

		it('treats the right/bottom edges as exclusive', () => {
			registry.create({
				windowId: 'w1',
				browserWindow: makeWindow({ x: 0, y: 0, width: 100, height: 100 }),
			});
			// Top-left corner is inside; the bottom-right corner is not.
			expect(registry.findWindowAtPoint(0, 0)).toBe('w1');
			expect(registry.findWindowAtPoint(100, 100)).toBeNull();
		});

		it('skips destroyed windows', () => {
			registry.create({
				windowId: 'dead',
				browserWindow: makeWindow({ x: 0, y: 0, width: 500, height: 500 }, true),
			});
			expect(registry.findWindowAtPoint(100, 100)).toBeNull();
		});
	});

	describe('change signal', () => {
		it('emits on create and remove with the window ID', () => {
			const changes: WindowRegistryChange[] = [];
			registry.onChange((c) => changes.push(c));

			const id = registry.create({ windowId: 'w1', browserWindow: makeWindow() });
			registry.remove(id);

			expect(changes).toEqual([
				{ type: 'created', windowId: 'w1' },
				{ type: 'removed', windowId: 'w1' },
			]);
		});

		it('onChange returns an unsubscribe that stops further notifications', () => {
			const listener = vi.fn();
			const unsubscribe = registry.onChange(listener);
			unsubscribe();
			registry.create({ windowId: 'w1', browserWindow: makeWindow() });
			expect(listener).not.toHaveBeenCalled();
		});
	});
});
