import test from 'node:test';
import assert from 'node:assert/strict';
import {sortFiles} from '../src/shared/file-sort';
import type {FileEntry} from '../src/shared/types';

function entry(name: string, values: Partial<FileEntry> = {}): FileEntry {
  return {name, path: `/${name}`, type: 'file', size: 1, modified: 1, ...values};
}

test('names use Chinese collation and natural numeric order', () => {
  const files = [entry('中10.txt'), entry('中2.txt'), entry('阿1.txt')];
  assert.deepEqual(sortFiles(files, 'name', 'ascending').map(file => file.name), ['阿1.txt', '中2.txt', '中10.txt']);
  assert.deepEqual(sortFiles(files, 'name', 'descending').map(file => file.name), ['中10.txt', '中2.txt', '阿1.txt']);
});

test('sizes sort by byte count, with directories first in both directions', () => {
  const files = [entry('2 MB', {size: 2 * 1024 * 1024}), entry('10 KB', {size: 10 * 1024}), entry('folder2', {type: 'directory', size: 100}), entry('folder1', {type: 'directory', size: 1000})];
  assert.deepEqual(sortFiles(files, 'size', 'ascending').map(file => file.name), ['folder1', 'folder2', '10 KB', '2 MB']);
  assert.deepEqual(sortFiles(files, 'size', 'descending').map(file => file.name), ['folder1', 'folder2', '2 MB', '10 KB']);
});

test('modification times sort chronologically and put unknown dates last', () => {
  const files = [entry('unknown', {modified: 0}), entry('new', {modified: Date.UTC(2026, 0, 1)}), entry('old', {modified: Date.UTC(2025, 11, 31)}), entry('invalid', {modified: NaN}), entry('out-of-range', {modified: 9e15})];
  assert.deepEqual(sortFiles(files, 'modified', 'ascending').map(file => file.name), ['old', 'new', 'invalid', 'out-of-range', 'unknown']);
  assert.deepEqual(sortFiles(files, 'modified', 'descending').map(file => file.name), ['new', 'old', 'invalid', 'out-of-range', 'unknown']);
});

test('missing or invalid sizes remain last and zero-byte files are known', () => {
  const files = [entry('invalid', {size: NaN}), entry('empty', {size: 0}), entry('full', {size: 1024}), entry('missing', {size: undefined})];
  assert.deepEqual(sortFiles(files, 'size', 'ascending').map(file => file.name), ['empty', 'full', 'invalid', 'missing']);
  assert.deepEqual(sortFiles(files, 'size', 'descending').map(file => file.name), ['full', 'empty', 'invalid', 'missing']);
});

test('permission sorting ignores file-type bits, includes special bits and leaves missing values last', () => {
  const files = [entry('unknown'), entry('special', {mode: 0o104644}), entry('private', {mode: 0o100600}), entry('link', {type: 'symlink', mode: 0o120400}), entry('none', {mode: 0})];
  assert.deepEqual(sortFiles(files, 'mode', 'ascending').map(file => file.name), ['none', 'link', 'private', 'special', 'unknown']);
  assert.deepEqual(sortFiles(files, 'mode', 'descending').map(file => file.name), ['special', 'private', 'link', 'none', 'unknown']);
});

test('metadata ties use ascending natural names and deterministic paths without mutating input', () => {
  const files = Object.freeze([entry('file10'), entry('file2', {path: '/b/file2'}), entry('file2', {path: '/a/file2'})].map(file => Object.freeze(file)));
  for (const key of ['size', 'modified', 'mode'] as const) {
    const sorted = sortFiles(files, key, 'descending');
    assert.deepEqual(sorted.map(file => file.path), ['/a/file2', '/b/file2', '/file10']);
    assert.notEqual(sorted, files);
  }
  assert.deepEqual(files.map(file => file.path), ['/file10', '/b/file2', '/a/file2']);
});
