// The browser can only reach allowlisted agent routes, and writes need Origin + CSRF token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAgentPath, csrfOk } from '../lib/server/allowlist.mjs';

const q = (s = '') => new URLSearchParams(s);

test('allowlisted routes map to /v1 paths', () => {
  assert.equal(toAgentPath('GET', ['status'], q()), '/v1/status');
  assert.equal(toAgentPath('POST', ['server', 'start'], q()), '/v1/server/start');
  assert.equal(toAgentPath('POST', ['worlds', 'wpanda01', 'activate'], q()), '/v1/worlds/wpanda01/activate');
  assert.equal(toAgentPath('DELETE', ['worlds', 'hopon', 'mods', 'P7dR8mSH'], q()), '/v1/worlds/hopon/mods/P7dR8mSH');
  assert.equal(toAgentPath('POST', ['users', 'me', 'mc-name'], q()), '/v1/users/me/mc-name');
});

test('the login route and unknown routes are not reachable from the browser', () => {
  assert.equal(toAgentPath('POST', ['auth', 'login'], q()), null);
  assert.equal(toAgentPath('GET', ['server', 'start'], q()), null, 'wrong method');
  assert.equal(toAgentPath('POST', ['worlds', 'x', 'shell'], q()), null);
  assert.equal(toAgentPath('PATCH', ['users', 'me'], q()), null, 'users cannot edit themselves via PATCH');
  assert.equal(toAgentPath('GET', [], q()), null);
});

test('path tricks are rejected', () => {
  assert.equal(toAgentPath('GET', ['worlds', '..', 'audit'], q()), null);
  assert.equal(toAgentPath('GET', ['worlds', '%2e%2e'], q()), null);
  assert.equal(toAgentPath('GET', ['worlds', 'a/b'], q()), null);
  assert.equal(toAgentPath('GET', ['worlds', 'UPPER'], q()), null);
});

test('only known query keys are forwarded, and only on GET', () => {
  assert.equal(toAgentPath('GET', ['mods', 'search'], q('q=graves&evil=1&offset=20')), '/v1/mods/search?q=graves&offset=20');
  assert.equal(toAgentPath('POST', ['queue'], q('q=x')), '/v1/queue');
});

test('CSRF: GET passes; writes need same origin and the session token', () => {
  const base = { host: 'localhost:3000', sessionCsrf: 'tok123' };
  assert.equal(csrfOk({ ...base, method: 'GET', origin: null, csrfHeader: null }), true);
  assert.equal(csrfOk({ ...base, method: 'POST', origin: 'http://localhost:3000', csrfHeader: 'tok123' }), true);
  assert.equal(csrfOk({ ...base, method: 'POST', origin: null, csrfHeader: 'tok123' }), false);
  assert.equal(csrfOk({ ...base, method: 'POST', origin: 'https://evil.example', csrfHeader: 'tok123' }), false);
  assert.equal(csrfOk({ ...base, method: 'POST', origin: 'http://localhost:3000', csrfHeader: 'nope00' }), false);
  assert.equal(csrfOk({ ...base, method: 'DELETE', origin: 'http://localhost:3000', csrfHeader: null }), false);
  assert.equal(csrfOk({ ...base, method: 'POST', origin: 'https://hop.vercel.app', csrfHeader: 'tok123', expectedOrigin: 'https://hop.vercel.app' }), true);
  assert.equal(csrfOk({ ...base, method: 'POST', origin: 'http://localhost:3000', csrfHeader: 'tok123', expectedOrigin: 'https://hop.vercel.app' }), false);
});
