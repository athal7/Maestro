/**
 * WindowContext
 *
 * Teaches the renderer that it is one of several windows. Every window learns
 * its own identity (`windowId` / `isMainWindow`) and the set of agents
 * (sessions) whose tab strips belong to it (`sessionIds` / `activeSessionId`).
 *
 * Identity comes from two sources:
 *   - `isMainWindow` and the initial `windowId` are read synchronously from the
 *     `?windowId=` query param the main process appends to a secondary window's
 *     entry URL (`buildEntryUrl` in `app-lifecycle/window-manager.ts`). The
 *     primary window loads the bare URL with no param, so a missing param means
 *     "this is the primary window".
 *   - Owned agents are hydrated from the main-process {@link WindowRegistry} via
 *     `window.maestro.windows.getState()`.
 *
 * Single-window-per-agent invariant: an agent lives in exactly one window.
 * `openSession` therefore focuses the owning window instead of stealing an
 * agent that already lives elsewhere.
 *
 * NOTE: the `windows:sessionMoved` broadcast listener that keeps this in sync
 * when agents move between windows is wired in a later Phase 2 task; `hydrate`
 * is factored out so it can be reused as that listener's refresh callback.
 */

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from 'react';

/**
 * Reads the `windowId` query param from the renderer URL. Returns `null` for
 * the primary window (which loads without the param) or when there is no DOM.
 */
function readWindowIdParam(): string | null {
	if (typeof window === 'undefined') return null;
	try {
		return new URLSearchParams(window.location.search).get('windowId');
	} catch {
		return null;
	}
}

/**
 * The agents scoped to a window plus which one is focused. Kept as one piece of
 * state so the active agent always stays consistent with the owned set (e.g.
 * when a tab closes).
 */
interface WindowScope {
	sessionIds: string[];
	activeSessionId: string | null;
}

export interface WindowContextValue {
	/** This window's stable ID. `null` only briefly before the first hydrate. */
	windowId: string | null;
	/** True for the primary window (loaded without a `windowId` param). */
	isMainWindow: boolean;
	/** Agent (session) IDs whose tab strips belong to THIS window. */
	sessionIds: string[];
	/** The agent currently focused in this window, or `null` when it owns none. */
	activeSessionId: string | null;
	/**
	 * Whether THIS window should surface the given agent's tab strip. The primary
	 * window is the catch-all owner (every agent no secondary window has claimed);
	 * a secondary window owns exactly the agents in its scoped `sessionIds`. The
	 * main tab bar uses this to scope which agent's tabs it renders.
	 */
	ownsSession: (sessionId: string) => boolean;
	/**
	 * Open/focus an agent in THIS window. If the agent already lives in another
	 * window, focuses that window instead of stealing it (single-window-per-agent).
	 */
	openSession: (sessionId: string) => Promise<void>;
	/** Remove an agent's tab strip from this window (does not delete the agent). */
	closeTab: (sessionId: string) => void;
	/** Detach an agent into a brand-new window, leaving this one. */
	moveSessionToNewWindow: (sessionId: string) => Promise<void>;
}

const WindowContext = createContext<WindowContextValue | null>(null);

/**
 * Pick the agent to focus after `removed` leaves the window. Mirrors the usual
 * tab-close behaviour: prefer the neighbour to the left, else the new first
 * tab, else nothing. A no-op (returns `current`) when the removed agent was not
 * the active one.
 */
function pickNextActive(
	sessionIds: string[],
	removed: string,
	current: string | null
): string | null {
	if (current !== removed) return current;
	const idx = sessionIds.indexOf(removed);
	const remaining = sessionIds.filter((id) => id !== removed);
	if (remaining.length === 0) return null;
	const nextIdx = Math.min(Math.max(0, idx - 1), remaining.length - 1);
	return remaining[nextIdx] ?? null;
}

/** Drop an agent from a window scope, re-pointing the active agent if needed. */
function removeFromScope(prev: WindowScope, sessionId: string): WindowScope {
	if (!prev.sessionIds.includes(sessionId)) return prev;
	return {
		sessionIds: prev.sessionIds.filter((id) => id !== sessionId),
		activeSessionId: pickNextActive(prev.sessionIds, sessionId, prev.activeSessionId),
	};
}

export function WindowProvider({ children }: { children: ReactNode }) {
	// isMainWindow and the initial windowId are known synchronously from the URL,
	// so the very first render already reflects the correct window identity.
	const paramWindowId = useMemo(() => readWindowIdParam(), []);
	const isMainWindow = paramWindowId === null;
	const [windowId, setWindowId] = useState<string | null>(paramWindowId);
	const [scope, setScope] = useState<WindowScope>({ sessionIds: [], activeSessionId: null });
	// Agents claimed by OTHER windows. The primary window is the catch-all owner,
	// so it needs to know which agents a secondary window has taken over to scope
	// its tab bar correctly. Empty in the common single-window case.
	const [sessionsOwnedElsewhere, setSessionsOwnedElsewhere] = useState<Set<string>>(
		() => new Set()
	);

	/**
	 * Pull this window's owned agents + active agent from the main-process
	 * registry, plus the agents owned by every other window. Reused on mount and
	 * (later Phase 2 task) when a `windows:sessionMoved` broadcast says ownership
	 * changed.
	 */
	const hydrate = useCallback(async () => {
		const [state, allWindows] = await Promise.all([
			window.maestro.windows.getState(),
			window.maestro.windows.list(),
		]);
		if (!state) return;
		// The primary window has no URL param, so adopt the registry's id for it.
		setWindowId((prev) => prev ?? state.id);
		setScope({ sessionIds: state.sessionIds, activeSessionId: state.activeSessionId });
		// Build the set of agents owned by windows other than this one.
		const elsewhere = new Set<string>();
		for (const win of allWindows ?? []) {
			if (win.id === state.id) continue;
			for (const sid of win.sessionIds) elsewhere.add(sid);
		}
		setSessionsOwnedElsewhere(elsewhere);
	}, []);

	useEffect(() => {
		void hydrate();
	}, [hydrate]);

	const ownsSession = useCallback(
		(sessionId: string): boolean =>
			// The primary window surfaces every agent that no secondary window has
			// explicitly claimed; a secondary window owns exactly its scoped set.
			isMainWindow ? !sessionsOwnedElsewhere.has(sessionId) : scope.sessionIds.includes(sessionId),
		[isMainWindow, sessionsOwnedElsewhere, scope.sessionIds]
	);

	const openSession = useCallback(
		async (sessionId: string) => {
			const ownerWindowId = await window.maestro.windows.getForSession(sessionId);
			if (ownerWindowId && ownerWindowId !== windowId) {
				// Lives in another window - focus it rather than stealing the agent.
				await window.maestro.windows.focusWindow(ownerWindowId);
				return;
			}
			// Owned here, or owned by no window yet: open/focus it locally.
			setScope((prev) => ({
				sessionIds: prev.sessionIds.includes(sessionId)
					? prev.sessionIds
					: [...prev.sessionIds, sessionId],
				activeSessionId: sessionId,
			}));
		},
		[windowId]
	);

	const closeTab = useCallback((sessionId: string) => {
		setScope((prev) => removeFromScope(prev, sessionId));
	}, []);

	const moveSessionToNewWindow = useCallback(
		async (sessionId: string) => {
			if (!windowId) return;
			const created = await window.maestro.windows.create([sessionId]);
			if (!created) return;
			// The new window already owns the agent; this transfer just removes it
			// from THIS window's registry ownership (enforcing single-window-per-agent)
			// and emits the move so other windows can refresh.
			await window.maestro.windows.moveSession(sessionId, windowId, created.id);
			setScope((prev) => removeFromScope(prev, sessionId));
		},
		[windowId]
	);

	const value = useMemo<WindowContextValue>(
		() => ({
			windowId,
			isMainWindow,
			sessionIds: scope.sessionIds,
			activeSessionId: scope.activeSessionId,
			ownsSession,
			openSession,
			closeTab,
			moveSessionToNewWindow,
		}),
		[
			windowId,
			isMainWindow,
			scope.sessionIds,
			scope.activeSessionId,
			ownsSession,
			openSession,
			closeTab,
			moveSessionToNewWindow,
		]
	);

	return <WindowContext.Provider value={value}>{children}</WindowContext.Provider>;
}

/**
 * Access the current window's identity and scoped agents. Throws if used
 * outside a {@link WindowProvider}.
 */
export function useWindowContext(): WindowContextValue {
	const context = useContext(WindowContext);
	if (!context) {
		throw new Error('useWindowContext must be used within a WindowProvider');
	}
	return context;
}

/**
 * Like {@link useWindowContext} but returns `null` instead of throwing when used
 * outside a {@link WindowProvider}. For components that mount both inside the
 * window-aware app and standalone (e.g. in isolation tests) - they degrade to
 * "no window scoping" rather than crashing.
 */
export function useWindowContextOptional(): WindowContextValue | null {
	return useContext(WindowContext);
}
