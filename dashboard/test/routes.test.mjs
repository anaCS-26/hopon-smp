// Every page the app links to must exist and must not be hidden by a .gitignore rule.
// (The root .gitignore ignores Minecraft "worlds/" folders, which once silently dropped the
// dashboard's own app/(app)/worlds pages from git, so the live site 404'd on the Worlds tab.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = [
  'app/(app)/page.tsx',
  'app/(app)/worlds/page.tsx',
  'app/(app)/worlds/new/page.tsx',
  'app/(app)/worlds/[id]/page.tsx',
  'app/(app)/console/page.tsx',
  'app/(app)/crew/page.tsx',
  'app/(app)/guides/page.tsx',
  'app/(app)/audit/page.tsx',
  'app/login/page.tsx',
];

function ignoredBy(file) {
  try {
    return execFileSync('git', ['check-ignore', '-v', '--', file], { cwd: root, encoding: 'utf8' }).trim();
  } catch (e) {
    if (e.status === 1) return null; // not ignored
    throw e;
  }
}

test('every linked page exists and is not git-ignored', () => {
  for (const p of PAGES) {
    assert.ok(fs.existsSync(path.join(root, p)), `${p} is missing`);
    assert.equal(ignoredBy(p), null, `${p} is git-ignored, so it would never reach Vercel`);
  }
});
