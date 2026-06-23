/**
 * Multi-Window State Migration
 *
 * One-shot, idempotent conversion of the legacy single-window persistence
 * (`maestro-window-state.json`: flat `{ x, y, width, height, isMaximized,
 * isFullScreen }`) into the multi-window `MultiWindowState` shape consumed by
 * the window registry and window manager.
 *
 * Idempotency is keyed on the data itself: once a well-formed `multiWindow`
 * field exists the migration is a no-op, so - unlike the settings-store
 * migrations - no separate marker is needed.
 *
 * The migration NEVER throws; a window-state hiccup must not block startup.
 * When the legacy value is absent (fresh install) or unreadable it seeds an
 * empty multi-window state instead.
 */

import type Store from 'electron-store';

import { generateUUID } from '../../../shared/uuid';
import type {
	MultiWindowState,
	WindowState as PersistedWindowState,
} from '../../../shared/window-types';
import { logger } from '../../utils/logger';
import type { WindowState } from '../types';

/** A multi-window state that tracks no windows yet. */
function createEmptyMultiWindowState(): MultiWindowState {
	return { windows: [], primaryWindowId: '' };
}

/**
 * True when the store holds real single-window state worth migrating. `width`
 * and `height` always come from `WINDOW_STATE_DEFAULTS`, so they are NOT a
 * signal - a persisted position or display mode is. A fresh install has none.
 */
function hasLegacyWindowState(legacy: WindowState): boolean {
	return (
		typeof legacy.x === 'number' ||
		typeof legacy.y === 'number' ||
		legacy.isMaximized === true ||
		legacy.isFullScreen === true
	);
}

/**
 * Fold the legacy single-window bounds/flags into a one-window MultiWindowState
 * whose lone window is the primary. `sessionIds` starts empty - this phase does
 * not yet assign agents to windows - and the side panels default to expanded.
 */
function multiWindowStateFromLegacy(legacy: WindowState): MultiWindowState {
	const primaryWindowId = generateUUID();
	const primary: PersistedWindowState = {
		id: primaryWindowId,
		// The legacy x/y are only persisted for normally-placed windows; a
		// maximized/fullscreen-only history leaves them undefined, in which case
		// the saved display mode wins and 0/0 is a harmless placeholder.
		x: legacy.x ?? 0,
		y: legacy.y ?? 0,
		width: legacy.width,
		height: legacy.height,
		isMaximized: legacy.isMaximized,
		isFullScreen: legacy.isFullScreen,
		sessionIds: [],
		activeSessionId: null,
		leftPanelCollapsed: false,
		rightPanelCollapsed: false,
	};
	return { windows: [primary], primaryWindowId };
}

/**
 * Migrate the window-state store to the multi-window schema in place. Safe to
 * call on every boot - returns early once `multiWindow` is populated.
 */
export function migrateWindowStateToMultiWindow(store: Store<WindowState>): void {
	try {
		const existing = store.get('multiWindow');
		if (existing && Array.isArray(existing.windows)) {
			return; // already migrated
		}

		const legacy = store.store;
		const multiWindow = hasLegacyWindowState(legacy)
			? multiWindowStateFromLegacy(legacy)
			: createEmptyMultiWindowState();

		store.set('multiWindow', multiWindow);
		logger.info(
			`Window-state multi-window migration complete - ${multiWindow.windows.length} window(s) seeded`,
			'Migration'
		);
	} catch (error) {
		// A window-state hiccup must never block startup. Fall back to an empty
		// multi-window state and carry on.
		logger.error('Window-state multi-window migration failed', 'Migration', error);
		try {
			store.set('multiWindow', createEmptyMultiWindowState());
		} catch {
			// If even the fallback write fails, leave the store as-is.
		}
	}
}
