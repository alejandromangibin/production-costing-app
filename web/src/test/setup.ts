import { cleanup } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import { problemsAfterTest } from './helpers';

// Testing Library only cleans up by itself when test functions are global, and this project keeps them imported.
afterEach(() => {
  const problems = problemsAfterTest(); // before cleanup, while the page is still on screen
  cleanup();
  vi.unstubAllGlobals();
  expect(problems).toEqual([]);
});
