import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { TestContext } from 'node:test';
import { Store } from '../src/desktop/store.js';

export function fixture(t: TestContext, clock?: () => Date) {
  const directory = mkdtempSync(join(tmpdir(), 'labrecord-test-'));
  let store = new Store(join(directory, 'workspace'), clock);
  t.after(() => {
    try {
      store.close();
    } catch {
      /* A test may already have closed the connection. */
    }
    if (
      !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
      !directory.split(sep).pop()?.startsWith('labrecord-test-')
    )
      throw new Error('Unexpected test directory');
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    directory,
    reopen() {
      store.close();
      store = new Store(join(directory, 'workspace'), clock);
      return store;
    },
  };
}
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=',
  'base64',
);
