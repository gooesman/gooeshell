import type {FileEntry} from './types';

export type FileSortKey = 'name' | 'size' | 'modified' | 'mode';
export type FileSortDirection = 'ascending' | 'descending';

const nameCollator = new Intl.Collator('zh-CN', {numeric: true, sensitivity: 'base'});

function compareNames(left: FileEntry, right: FileEntry): number {
  return nameCollator.compare(left.name, right.name)
    || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function numericValue(entry: FileEntry, key: Exclude<FileSortKey, 'name'>): number | undefined {
  const value = entry[key];
  if (value === undefined || !Number.isFinite(value)) return undefined;
  if (key === 'size') return entry.type === 'directory' || value < 0 ? undefined : value;
  if (key === 'modified') return value === 0 || Number.isNaN(new Date(value).getTime()) ? undefined : value;
  return Number.isInteger(value) && value >= 0 ? value & 0o7777 : undefined;
}

/** Keep folders first and unavailable metadata last, regardless of sort direction. */
export function sortFiles(entries: readonly FileEntry[], key: FileSortKey, direction: FileSortDirection): FileEntry[] {
  const multiplier = direction === 'ascending' ? 1 : -1;
  return [...entries].sort((left, right) => {
    const directories = Number(right.type === 'directory') - Number(left.type === 'directory');
    if (directories) return directories;
    if (key === 'name') return compareNames(left, right) * multiplier;
    const leftValue = numericValue(left, key);
    const rightValue = numericValue(right, key);
    if (leftValue === undefined && rightValue !== undefined) return 1;
    if (rightValue === undefined && leftValue !== undefined) return -1;
    if (leftValue !== undefined && rightValue !== undefined && leftValue !== rightValue) {
      return (leftValue < rightValue ? -1 : 1) * multiplier;
    }
    return compareNames(left, right);
  });
}
