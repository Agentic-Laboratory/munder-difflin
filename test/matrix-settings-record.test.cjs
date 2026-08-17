'use strict';

/**
 * The record Settings → Matrix writes when the human pastes a bot access token.
 *
 * The renderer has no React test harness, so the testable piece is the pure
 * record builder SettingsModal delegates to. What it has to get right is the
 * half of `matrixOutboundCredentials()` (src/main/index.ts) that lives in a
 * record: found by main's OWN id-then-label ladder, enabled, carrying the
 * secretRef the token is stored under, and pointing at the same homeserver the
 * config does. Miss any one and the bot listens but never replies.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { buildMatrixIntegrationRecord, findMatrixRecord, MATRIX_INTEGRATION_ID } =
  loadTs('src/renderer/src/components/matrixIntegrationRecord.ts');
const { INTEGRATION_TEMPLATES, secretRefFor } = loadTs('src/shared/integrations.ts');

const HOMESERVER = 'https://matrix.example.org';
const NOW = 1_700_000_000_000;

const build = (records, homeserverUrl = HOMESERVER) =>
  buildMatrixIntegrationRecord({ templates: INTEGRATION_TEMPLATES, records, homeserverUrl, now: NOW });

const matrixTemplate = () => INTEGRATION_TEMPLATES.find((t) => t.idSuggestion === MATRIX_INTEGRATION_ID);

test('a first save produces credentials main can actually resolve', () => {
  const res = build([]);
  assert.equal(res.ok, true);
  const r = res.record;
  assert.equal(r.id, 'matrix', 'main prefers the conventional id');
  assert.equal(r.enabled, true, 'a disabled record = the bot reads but never replies');
  assert.equal(r.secretRef, secretRefFor('matrix'), 'the token is stored under this exact handle');
  assert.equal(r.baseUrl, HOMESERVER, 'the broker forwards to baseUrl, not to config');
  assert.equal(r.createdAt, NOW);
  assert.equal(r.updatedAt, NOW);
});

test('kind and authType come from the served template, not hand-authored', () => {
  const tpl = matrixTemplate();
  const r = build([]).record;
  assert.equal(r.kind, tpl.kind);
  assert.equal(r.authType, tpl.authType);
  assert.equal(r.authHeader, tpl.authHeader);
});

test('an existing id:matrix record is UPDATED, never duplicated', () => {
  const res = build([{ id: 'matrix', label: 'Matrix', createdAt: 1, enabled: false }]);
  assert.equal(res.ok, true);
  assert.equal(res.record.id, 'matrix');
  assert.equal(res.record.createdAt, 1, 'the original creation time survives an update');
  assert.equal(res.record.enabled, true, 'saving re-enables the record the bot needs');
});

test('a record registered under ANOTHER id but labelled Matrix is the one written', () => {
  // Trap: main falls back to label when id 'matrix' is absent. Creating a fresh
  // id:'matrix' record here would leave main reading the OLD, secret-less one.
  const res = build([{ id: 'matrix-home', label: 'Matrix', createdAt: 42 }]);
  assert.equal(res.ok, true);
  assert.equal(res.record.id, 'matrix-home');
  assert.equal(res.record.secretRef, secretRefFor('matrix-home'), 'the token follows the id main resolves');
  assert.equal(res.record.label, 'Matrix', 'clobbering the label would break the fallback lookup');
  assert.equal(res.record.createdAt, 42);
});

test('with both present, the id match wins — matching main resolution order', () => {
  const res = build([
    { id: 'matrix-home', label: 'Matrix', createdAt: 42 },
    { id: 'matrix', label: 'Matrix bot', createdAt: 7 }
  ]);
  assert.equal(res.record.id, 'matrix');
  assert.equal(res.record.createdAt, 7);
});

test('the label ladder matches the way main matches it', () => {
  assert.equal(findMatrixRecord([{ id: 'mx', label: '  MATRIX  ' }]).id, 'mx');
  assert.equal(findMatrixRecord([{ id: 'mx', label: 'Matrix Bridge' }]), undefined);
  assert.equal(findMatrixRecord([]), undefined);
});

test('an edited homeserver moves the record with it', () => {
  const moved = build([{ id: 'matrix', label: 'Matrix', createdAt: 1 }], 'https://new.example.org');
  assert.equal(moved.record.baseUrl, 'https://new.example.org');
});

test('a blank homeserver is refused, not silently saved', () => {
  for (const blank of ['', '   ']) {
    const res = build([], blank);
    assert.equal(res.ok, false);
    assert.match(res.error, /homeserver/i);
  }
});

test('an untrusted homeserver origin is refused by the shared TLS gate', () => {
  const res = build([], 'http://matrix.example.org');
  assert.equal(res.ok, false);
  assert.match(res.error, /https/);
});

test('the homeserver is trimmed before it reaches the record', () => {
  assert.equal(build([], `  ${HOMESERVER}  `).record.baseUrl, HOMESERVER);
});

test('no Matrix template served => an explicit error, never a guessed record', () => {
  const res = buildMatrixIntegrationRecord({
    templates: [], records: [], homeserverUrl: HOMESERVER, now: NOW
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /template/);
});
