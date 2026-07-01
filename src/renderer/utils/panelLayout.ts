// Panel layout helpers - pure, side-effect-free tree utilities for tmux-style
// tab tiling (split panes). Mirrors the functional style of tabHelpers.ts and
// terminalTabHelpers.ts: every function takes a node/group and returns a new
// one, never mutating its input.
//
// A layout is a recursive tree of PanelLayoutNode. Leaves reference existing
// tabs by UnifiedTabRef ({ type, id }); they never own tab data, so tiling a
// tab never copies or relocates its state. Splits arrange children in a row or
// column with fractional `sizes` (one weight per child, summing to 1).

import type { PanelLayoutNode, TabGroup, UnifiedTabRef } from '../types';
import { generateId } from './ids';

/** Compare two tab refs by type + id (leaves reference tabs by value, not identity). */
function sameTabRef(a: UnifiedTabRef, b: UnifiedTabRef): boolean {
	return a.type === b.type && a.id === b.id;
}

/** Normalize an array of weights so it sums to 1 (falls back to equal weights). */
function normalizeSizes(sizes: number[]): number[] {
	const total = sizes.reduce((sum, n) => sum + n, 0);
	if (total <= 0) {
		return sizes.map(() => 1 / sizes.length);
	}
	return sizes.map((n) => n / total);
}

/** Build a leaf node that references an existing tab. */
export function createLeaf(tab: UnifiedTabRef): PanelLayoutNode {
	return { kind: 'leaf', id: generateId(), tab };
}

/**
 * Build a TabGroup from a set of tab refs: one top-level `row` split with an
 * equal-sized leaf per tab (each weight `1 / n`). The first leaf is focused.
 */
export function createGroupFromTabRefs(tabs: UnifiedTabRef[], name: string): TabGroup {
	const children = tabs.map((tab) => createLeaf(tab));
	const sizes = children.map(() => 1 / children.length);
	const layout: PanelLayoutNode = {
		kind: 'split',
		id: generateId(),
		direction: 'row',
		children,
		sizes,
	};
	return {
		id: generateId(),
		name,
		layout,
		focusedPaneId: children[0]?.id ?? null,
		createdAt: Date.now(),
	};
}

/**
 * Replace the leaf identified by `leafId` with a split that holds the original
 * leaf plus a new leaf for `newTab`, dividing the space `[0.5, 0.5]`.
 *
 * tmux behavior: when the target leaf's parent split already runs in the
 * requested `direction`, the new leaf is inserted as a sibling in that parent
 * (rebalanced to equal weights) instead of nesting a fresh split - so repeated
 * splits in one direction produce a flat row/column rather than a deep tree.
 */
export function splitLeaf(
	layout: PanelLayoutNode,
	leafId: string,
	direction: 'row' | 'column',
	newTab: UnifiedTabRef
): PanelLayoutNode {
	const newLeaf = createLeaf(newTab);

	function recurse(node: PanelLayoutNode): PanelLayoutNode {
		if (node.kind === 'leaf') {
			// A bare leaf with no parent split (single-pane layout): wrap it.
			if (node.id === leafId) {
				return {
					kind: 'split',
					id: generateId(),
					direction,
					children: [node, newLeaf],
					sizes: [0.5, 0.5],
				};
			}
			return node;
		}

		// If a direct child of this split is the target leaf and the split already
		// runs in the requested direction, insert the new leaf as a sibling here
		// (flat, tmux-style) rather than nesting a new split around the leaf.
		const targetIndex = node.children.findIndex(
			(child) => child.kind === 'leaf' && child.id === leafId
		);
		if (targetIndex !== -1 && node.direction === direction) {
			const children = [
				...node.children.slice(0, targetIndex + 1),
				newLeaf,
				...node.children.slice(targetIndex + 1),
			];
			const sizes = children.map(() => 1 / children.length);
			return { ...node, children, sizes };
		}

		// Otherwise recurse: the target leaf either lives deeper or its parent
		// split runs in the other direction (so it must nest a new split).
		return { ...node, children: node.children.map(recurse) };
	}

	return recurse(layout);
}

/**
 * Remove the leaf matching `tab` from the tree. The parent split's `sizes` are
 * renormalized over the remaining children, and any split reduced to a single
 * child collapses into that child. Returns `null` if the removed leaf was the
 * last one in the tree.
 */
export function removeLeafByTabRef(
	layout: PanelLayoutNode,
	tab: UnifiedTabRef
): PanelLayoutNode | null {
	function recurse(node: PanelLayoutNode): PanelLayoutNode | null {
		if (node.kind === 'leaf') {
			return sameTabRef(node.tab, tab) ? null : node;
		}

		const survivors: PanelLayoutNode[] = [];
		const survivorSizes: number[] = [];
		node.children.forEach((child, index) => {
			const kept = recurse(child);
			if (kept !== null) {
				survivors.push(kept);
				survivorSizes.push(node.sizes[index]);
			}
		});

		if (survivors.length === 0) return null;
		// Collapse a split left with a single child into that child.
		if (survivors.length === 1) return survivors[0];
		return { ...node, children: survivors, sizes: normalizeSizes(survivorSizes) };
	}

	return recurse(layout);
}

/** Find the leaf that references `tab`, or null if none matches. */
export function findLeafByTabRef(
	layout: PanelLayoutNode,
	tab: UnifiedTabRef
): PanelLayoutNode | null {
	if (layout.kind === 'leaf') {
		return sameTabRef(layout.tab, tab) ? layout : null;
	}
	for (const child of layout.children) {
		const found = findLeafByTabRef(child, tab);
		if (found) return found;
	}
	return null;
}

/** Find the leaf whose node id is `leafId`, or null if none matches. */
export function findLeafById(layout: PanelLayoutNode, leafId: string): PanelLayoutNode | null {
	if (layout.kind === 'leaf') {
		return layout.id === leafId ? layout : null;
	}
	for (const child of layout.children) {
		const found = findLeafById(child, leafId);
		if (found) return found;
	}
	return null;
}

/** Collect every leaf's tab ref, left-to-right / top-to-bottom. */
export function collectLeafTabRefs(layout: PanelLayoutNode): UnifiedTabRef[] {
	if (layout.kind === 'leaf') return [layout.tab];
	return layout.children.flatMap(collectLeafTabRefs);
}

/** Count the leaves in a layout tree. */
export function countLeaves(layout: PanelLayoutNode): number {
	if (layout.kind === 'leaf') return 1;
	return layout.children.reduce((sum, child) => sum + countLeaves(child), 0);
}

/** Build an auto group name from the first tab's title (used for auto-naming). */
export function generateGroupName(firstTabTitle: string): string {
	return `Group: ${firstTabTitle}`;
}

/** True when a unified tab ref points at a TabGroup rather than a single tab. */
export function isGroupRef(ref: UnifiedTabRef): boolean {
	return ref.type === 'group';
}
