import React from 'react';

import { TerminalOutput } from '../TerminalOutput';
import { useSettingsStore } from '../../stores/settingsStore';
import { getTabDisplayName } from '../../utils/tabHelpers';
import { getTerminalTabDisplayName } from '../../utils/terminalTabHelpers';
import type { PanelLayoutNode, Session, TabGroup, Theme, UnifiedTabRef } from '../../types';

// Lazy-loaded to match MainPanelContent: FilePreview pulls the full markdown /
// syntax-highlighting stack into the bundle, so it stays code-split behind first
// open here too.
const FilePreview = React.lazy(() =>
	import('../FilePreview').then((m) => ({ default: m.FilePreview }))
);

/**
 * Recursive renderer for a tiled TabGroup. Walks the group's layout tree and
 * renders each leaf's referenced tab side by side. Leaves reference existing
 * tabs (see PanelLayoutNode), so this component resolves each ref back to its
 * live tab in the session and reuses the same view components MainPanelContent
 * uses (TerminalOutput for AI, FilePreview for files). Terminal and browser
 * leaves show a placeholder for now - their keep-alive overlay repositioning is
 * deferred to a later phase.
 *
 * Static tiling only: splits render as flex containers whose children are sized
 * by the node's `sizes` weights. No drag-to-resize yet.
 */
export interface TiledLayoutProps {
	group: TabGroup;
	session: Session;
	theme: Theme;
}

/** Resolve a leaf's display title from the live tab it references. */
function resolveLeafTitle(tab: UnifiedTabRef, session: Session): string {
	switch (tab.type) {
		case 'ai': {
			const aiTab = session.aiTabs?.find((t) => t.id === tab.id);
			return aiTab ? getTabDisplayName(aiTab) : 'AI';
		}
		case 'file': {
			const fileTab = session.filePreviewTabs?.find((t) => t.id === tab.id);
			return fileTab ? fileTab.name : 'File';
		}
		case 'terminal': {
			const index = session.terminalTabs?.findIndex((t) => t.id === tab.id) ?? -1;
			const terminalTab = index >= 0 ? session.terminalTabs[index] : undefined;
			return terminalTab ? getTerminalTabDisplayName(terminalTab, index) : 'Terminal';
		}
		case 'browser': {
			const browserTab = session.browserTabs?.find((t) => t.id === tab.id);
			return browserTab
				? (browserTab.customTitle ?? browserTab.title ?? browserTab.url)
				: 'Browser';
		}
		default:
			return 'Tab';
	}
}

/** Placeholder shown for tab kinds whose tiled rendering lands in a later phase. */
function PaneComingSoon({ theme, label }: { theme: Theme; label: string }) {
	return (
		<div
			className="flex-1 flex items-center justify-center select-none"
			style={{ backgroundColor: theme.colors.bgMain }}
		>
			<div
				className="text-xs text-center px-4 py-2 rounded"
				style={{
					color: theme.colors.textDim,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				Tiling for {label} tabs arrives in a later phase
			</div>
		</div>
	);
}

/** Render a single leaf's tab content, reusing existing view components. */
function PaneContent({
	tab,
	session,
	theme,
}: {
	tab: UnifiedTabRef;
	session: Session;
	theme: Theme;
}) {
	const fontFamily = useSettingsStore((s) => s.fontFamily);
	const maxOutputLines = useSettingsStore((s) => s.maxOutputLines);
	const chatRawTextMode = useSettingsStore((s) => s.chatRawTextMode);
	const shortcuts = useSettingsStore((s) => s.shortcuts);

	// Local, per-pane refs. In this static read/display prototype the panes are not
	// interactive (no input wiring, no output search), so search state and setters
	// are inert - the display renderer still needs the props to satisfy its API.
	const outputRef = React.useRef<HTMLDivElement>(null);
	const inputRef = React.useRef<HTMLTextAreaElement>(null);
	const logsEndRef = React.useRef<HTMLDivElement>(null);
	const noop = React.useCallback(() => {}, []);

	if (tab.type === 'ai') {
		const aiTab = session.aiTabs?.find((t) => t.id === tab.id);
		if (!aiTab) return <PaneComingSoon theme={theme} label="this" />;
		// Scope the session to this pane's AI tab so TerminalOutput renders the
		// correct conversation (it reads logs off the active tab).
		const paneSession: Session = { ...session, activeTabId: aiTab.id, inputMode: 'ai' };
		return (
			<div className="flex-1 overflow-hidden flex flex-col select-text">
				<TerminalOutput
					ref={outputRef}
					session={paneSession}
					theme={theme}
					fontFamily={fontFamily}
					activeFocus="main"
					outputSearchOpen={false}
					outputSearchQuery=""
					outputSearchRegex={false}
					setOutputSearchOpen={noop}
					setOutputSearchQuery={noop}
					setOutputSearchRegex={noop}
					setActiveFocus={noop}
					setLightboxImage={noop}
					inputRef={inputRef}
					logsEndRef={logsEndRef}
					maxOutputLines={maxOutputLines}
					markdownEditMode={chatRawTextMode}
					setMarkdownEditMode={noop}
					projectRoot={session.fullPath}
				/>
			</div>
		);
	}

	if (tab.type === 'file') {
		const fileTab = session.filePreviewTabs?.find((t) => t.id === tab.id);
		if (!fileTab) return <PaneComingSoon theme={theme} label="this" />;
		return (
			<div className="flex-1 overflow-hidden select-text">
				<React.Suspense fallback={null}>
					<FilePreview
						file={{ name: fileTab.name, path: fileTab.path, content: fileTab.content }}
						onClose={noop}
						isTabMode={true}
						theme={theme}
						shortcuts={shortcuts}
						markdownEditMode={false}
						setMarkdownEditMode={noop}
					/>
				</React.Suspense>
			</div>
		);
	}

	if (tab.type === 'terminal') return <PaneComingSoon theme={theme} label="terminal" />;
	return <PaneComingSoon theme={theme} label="browser" />;
}

/** A single leaf pane: a title bar (future drag handle) atop the tab content. */
function PaneFrame({
	node,
	session,
	theme,
	isFocused,
}: {
	node: Extract<PanelLayoutNode, { kind: 'leaf' }>;
	session: Session;
	theme: Theme;
	isFocused: boolean;
}) {
	const title = resolveLeafTitle(node.tab, session);
	return (
		<div
			className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden"
			style={{
				border: `1px solid ${isFocused ? theme.colors.accent : theme.colors.border}`,
			}}
		>
			{/* Title bar - doubles as the drag handle in a later phase. */}
			<div
				className="shrink-0 px-2 py-1 text-xs font-medium truncate select-none"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					color: theme.colors.textMain,
					borderBottom: `1px solid ${theme.colors.border}`,
				}}
				title={title}
			>
				{title}
			</div>
			<PaneContent tab={node.tab} session={session} theme={theme} />
		</div>
	);
}

/** Recursively render one layout node (leaf -> PaneFrame, split -> flex row/col). */
function LayoutNode({
	node,
	group,
	session,
	theme,
}: {
	node: PanelLayoutNode;
	group: TabGroup;
	session: Session;
	theme: Theme;
}) {
	if (node.kind === 'leaf') {
		return (
			<PaneFrame
				node={node}
				session={session}
				theme={theme}
				isFocused={group.focusedPaneId === node.id}
			/>
		);
	}
	return (
		<div
			className={`flex flex-1 min-w-0 min-h-0 ${node.direction === 'row' ? 'flex-row' : 'flex-col'}`}
		>
			{node.children.map((child, index) => (
				<div
					key={child.id}
					className="flex min-w-0 min-h-0 overflow-hidden"
					style={{ flexGrow: node.sizes[index], flexBasis: 0 }}
				>
					<LayoutNode node={child} group={group} session={session} theme={theme} />
				</div>
			))}
		</div>
	);
}

export const TiledLayout = React.memo(function TiledLayout({
	group,
	session,
	theme,
}: TiledLayoutProps) {
	return (
		<div className="flex-1 min-h-0 overflow-hidden flex flex-col" data-tour="tiled-layout">
			<LayoutNode node={group.layout} group={group} session={session} theme={theme} />
		</div>
	);
});
