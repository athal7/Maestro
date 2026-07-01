/**
 * Tests for panelLayout.ts - pure split-pane layout tree utilities (tab tiling).
 *
 * Functions tested:
 * - createLeaf
 * - createGroupFromTabRefs
 * - splitLeaf (both directions, same-direction parent reuse, size normalization)
 * - removeLeafByTabRef (rebalance, single-child collapse, last-leaf -> null)
 * - findLeafByTabRef / findLeafById
 * - collectLeafTabRefs / countLeaves
 * - generateGroupName / isGroupRef
 */

import { describe, it, expect } from 'vitest';
import type { PanelLayoutNode, UnifiedTabRef } from '../../types';
import {
	createLeaf,
	createGroupFromTabRefs,
	splitLeaf,
	removeLeafByTabRef,
	findLeafByTabRef,
	findLeafById,
	collectLeafTabRefs,
	countLeaves,
	generateGroupName,
	isGroupRef,
} from '../panelLayout';

const aiRef = (id: string): UnifiedTabRef => ({ type: 'ai', id });
const fileRef = (id: string): UnifiedTabRef => ({ type: 'file', id });

/** Sum of a split node's sizes, rounded to avoid float noise. */
function sizesSum(node: PanelLayoutNode): number {
	if (node.kind !== 'split') return 0;
	return Number(node.sizes.reduce((a, b) => a + b, 0).toFixed(6));
}

describe('createLeaf', () => {
	it('builds a leaf that references the given tab and has a generated id', () => {
		const leaf = createLeaf(aiRef('a'));
		expect(leaf.kind).toBe('leaf');
		expect(leaf).toMatchObject({ kind: 'leaf', tab: { type: 'ai', id: 'a' } });
		expect(typeof leaf.id).toBe('string');
		expect(leaf.id.length).toBeGreaterThan(0);
	});
});

describe('createGroupFromTabRefs', () => {
	it('produces equal sizes summing to 1 and a focused first pane', () => {
		const group = createGroupFromTabRefs([aiRef('a'), fileRef('b'), aiRef('c')], 'My Group');

		expect(group.name).toBe('My Group');
		expect(typeof group.id).toBe('string');
		expect(group.createdAt).toBeGreaterThan(0);

		const layout = group.layout;
		expect(layout.kind).toBe('split');
		if (layout.kind !== 'split') throw new Error('expected split');

		// One equal-sized leaf per tab, weights sum to 1.
		expect(layout.direction).toBe('row');
		expect(layout.children).toHaveLength(3);
		expect(layout.sizes).toEqual([1 / 3, 1 / 3, 1 / 3]);
		expect(sizesSum(layout)).toBe(1);

		// Every child is a leaf referencing the input tabs in order.
		expect(collectLeafTabRefs(layout)).toEqual([aiRef('a'), fileRef('b'), aiRef('c')]);

		// The first leaf is focused.
		expect(group.focusedPaneId).toBe(layout.children[0].id);
	});
});

describe('splitLeaf', () => {
	it('splits a single-leaf layout in the row direction', () => {
		const leaf = createLeaf(aiRef('a'));
		const result = splitLeaf(leaf, leaf.id, 'row', aiRef('b'));

		expect(result.kind).toBe('split');
		if (result.kind !== 'split') throw new Error('expected split');
		expect(result.direction).toBe('row');
		expect(result.sizes).toEqual([0.5, 0.5]);
		expect(collectLeafTabRefs(result)).toEqual([aiRef('a'), aiRef('b')]);
	});

	it('splits a single-leaf layout in the column direction', () => {
		const leaf = createLeaf(aiRef('a'));
		const result = splitLeaf(leaf, leaf.id, 'column', aiRef('b'));

		expect(result.kind).toBe('split');
		if (result.kind !== 'split') throw new Error('expected split');
		expect(result.direction).toBe('column');
		expect(result.sizes).toEqual([0.5, 0.5]);
	});

	it('reuses a same-direction parent split instead of nesting (tmux behavior)', () => {
		const group = createGroupFromTabRefs([aiRef('a'), aiRef('b')], 'g');
		const rowSplit = group.layout;
		if (rowSplit.kind !== 'split') throw new Error('expected split');
		const targetLeafId = rowSplit.children[0].id;

		// Split the first leaf in the SAME (row) direction: the new leaf becomes a
		// sibling in the existing row, not a nested split.
		const result = splitLeaf(rowSplit, targetLeafId, 'row', aiRef('c'));
		expect(result.kind).toBe('split');
		if (result.kind !== 'split') throw new Error('expected split');
		expect(result.direction).toBe('row');
		// Flat: 3 leaf children, none of them nested splits.
		expect(result.children).toHaveLength(3);
		expect(result.children.every((c) => c.kind === 'leaf')).toBe(true);
		// New leaf inserted directly after the target.
		expect(collectLeafTabRefs(result)).toEqual([aiRef('a'), aiRef('c'), aiRef('b')]);
		// Sizes stay normalized and equal.
		expect(result.sizes).toEqual([1 / 3, 1 / 3, 1 / 3]);
		expect(sizesSum(result)).toBe(1);
	});

	it('nests a new split when the parent runs in the other direction', () => {
		const group = createGroupFromTabRefs([aiRef('a'), aiRef('b')], 'g');
		const rowSplit = group.layout;
		if (rowSplit.kind !== 'split') throw new Error('expected split');
		const targetLeafId = rowSplit.children[0].id;

		// Split the first leaf in the COLUMN direction: the parent is a row, so the
		// target leaf is replaced by a nested column split.
		const result = splitLeaf(rowSplit, targetLeafId, 'column', aiRef('c'));
		if (result.kind !== 'split') throw new Error('expected split');
		expect(result.direction).toBe('row');
		expect(result.children).toHaveLength(2);

		const firstChild = result.children[0];
		expect(firstChild.kind).toBe('split');
		if (firstChild.kind !== 'split') throw new Error('expected nested split');
		expect(firstChild.direction).toBe('column');
		expect(firstChild.sizes).toEqual([0.5, 0.5]);
		expect(collectLeafTabRefs(result)).toEqual([aiRef('a'), aiRef('c'), aiRef('b')]);
	});
});

describe('removeLeafByTabRef', () => {
	it('rebalances the parent split sizes after removal', () => {
		const group = createGroupFromTabRefs([aiRef('a'), aiRef('b'), aiRef('c')], 'g');
		const result = removeLeafByTabRef(group.layout, aiRef('b'));

		expect(result).not.toBeNull();
		if (!result || result.kind !== 'split') throw new Error('expected split');
		expect(result.children).toHaveLength(2);
		expect(collectLeafTabRefs(result)).toEqual([aiRef('a'), aiRef('c')]);
		// Two remaining children, renormalized to equal weights summing to 1.
		expect(result.sizes).toEqual([0.5, 0.5]);
		expect(sizesSum(result)).toBe(1);
	});

	it('collapses a split left with a single child into that child', () => {
		const group = createGroupFromTabRefs([aiRef('a'), aiRef('b')], 'g');
		const result = removeLeafByTabRef(group.layout, aiRef('b'));

		// Removing one of two leaves leaves a single-child split, which collapses to
		// the surviving leaf.
		expect(result).not.toBeNull();
		if (!result) throw new Error('expected node');
		expect(result.kind).toBe('leaf');
		if (result.kind !== 'leaf') throw new Error('expected leaf');
		expect(result.tab).toEqual(aiRef('a'));
	});

	it('collapses nested single-child splits recursively', () => {
		// row[ column[a, b], c ] -> remove b -> column collapses to a -> row[a, c]
		const group = createGroupFromTabRefs([aiRef('x'), aiRef('c')], 'g');
		const rowSplit = group.layout;
		if (rowSplit.kind !== 'split') throw new Error('expected split');
		const nested = splitLeaf(rowSplit, rowSplit.children[0].id, 'column', aiRef('b'));
		// nested is: row[ column[x, b], c ]
		const result = removeLeafByTabRef(nested, aiRef('b'));
		expect(result).not.toBeNull();
		if (!result || result.kind !== 'split') throw new Error('expected split');
		expect(result.direction).toBe('row');
		expect(collectLeafTabRefs(result)).toEqual([aiRef('x'), aiRef('c')]);
		expect(result.children.every((child) => child.kind === 'leaf')).toBe(true);
	});

	it('returns null when the last leaf is removed', () => {
		const leaf = createLeaf(aiRef('only'));
		expect(removeLeafByTabRef(leaf, aiRef('only'))).toBeNull();
	});

	it('leaves the tree unchanged when the tab is not found', () => {
		const group = createGroupFromTabRefs([aiRef('a'), aiRef('b')], 'g');
		const result = removeLeafByTabRef(group.layout, aiRef('missing'));
		expect(result).not.toBeNull();
		expect(collectLeafTabRefs(result as PanelLayoutNode)).toEqual([aiRef('a'), aiRef('b')]);
	});
});

describe('collectLeafTabRefs / countLeaves / findLeaf*', () => {
	// Build a nested tree: row[ column[a, b], c ]
	function buildNested() {
		const group = createGroupFromTabRefs([aiRef('a'), aiRef('c')], 'g');
		const rowSplit = group.layout;
		if (rowSplit.kind !== 'split') throw new Error('expected split');
		return splitLeaf(rowSplit, rowSplit.children[0].id, 'column', fileRef('b'));
	}

	it('collectLeafTabRefs returns all leaf refs in order on a nested tree', () => {
		const tree = buildNested();
		expect(collectLeafTabRefs(tree)).toEqual([aiRef('a'), fileRef('b'), aiRef('c')]);
	});

	it('countLeaves counts every leaf in a nested tree', () => {
		const tree = buildNested();
		expect(countLeaves(tree)).toBe(3);
		expect(countLeaves(createLeaf(aiRef('solo')))).toBe(1);
	});

	it('findLeafByTabRef finds the matching leaf or null', () => {
		const tree = buildNested();
		const found = findLeafByTabRef(tree, fileRef('b'));
		expect(found).not.toBeNull();
		expect(found?.kind).toBe('leaf');
		if (found?.kind === 'leaf') expect(found.tab).toEqual(fileRef('b'));
		expect(findLeafByTabRef(tree, aiRef('nope'))).toBeNull();
	});

	it('findLeafById finds the leaf by node id or null', () => {
		const leaf = createLeaf(aiRef('a'));
		const tree = splitLeaf(leaf, leaf.id, 'row', aiRef('b'));
		if (tree.kind !== 'split') throw new Error('expected split');
		const targetId = tree.children[1].id;
		const found = findLeafById(tree, targetId);
		expect(found?.id).toBe(targetId);
		expect(findLeafById(tree, 'does-not-exist')).toBeNull();
	});
});

describe('generateGroupName / isGroupRef', () => {
	it('generateGroupName prefixes the first tab title', () => {
		expect(generateGroupName('Feature X')).toBe('Group: Feature X');
	});

	it('isGroupRef is true only for group refs', () => {
		expect(isGroupRef({ type: 'group', id: 'g1' })).toBe(true);
		expect(isGroupRef(aiRef('a'))).toBe(false);
		expect(isGroupRef(fileRef('f'))).toBe(false);
	});
});
