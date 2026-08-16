// The record half of "save the Matrix bot access token from Settings".
//
// Settings → Matrix persists two INDEPENDENT things: the config keys the /sync
// listener reads (matrixHomeserverUrl/matrixUserId/matrixRoomIds/matrixEnabled),
// and a registered integration record whose encrypted secret is the OUTBOUND
// access token. `matrixOutboundCredentials()` in src/main/index.ts needs BOTH,
// and it needs four things at once: a non-empty configured homeserver, a record
// found by id `matrix` (falling back to label "Matrix"), `record.enabled`, and a
// stored secret at `record.secretRef`. This module builds the record so that
// conjunction can actually close.
//
// Pure on purpose: no React, no IPC, no window. The renderer has no test
// harness, so this is the piece that is unit-tested (test/matrix-settings-record.test.cjs),
// and SettingsModal only wires it to the client.

import {
  secretRefFor,
  validateIntegrationRecord,
  type IntegrationRecord,
  type IntegrationTemplate
} from '@shared/integrations';

/** The conventional id — the Matrix template's `idSuggestion`, and the id
 *  `matrixOutboundCredentials()` prefers when resolving the token. */
export const MATRIX_INTEGRATION_ID = 'matrix';

/** The subset of a listed record this module needs. Deliberately structural, so
 *  it accepts the redacted `IntegrationRecordView` the renderer actually holds —
 *  the renderer never sees a `secretRef`, let alone a secret. */
export interface MatrixRecordLookup {
  id: string;
  label: string;
  createdAt: number;
}

/**
 * Find the record `matrixOutboundCredentials()` WOULD resolve, using main's exact
 * ladder (src/main/index.ts:1684-1687): id `matrix` first, then a record labelled
 * "Matrix". Reusing this ladder is what stops a save from creating a SECOND record
 * beside one the user already registered under another id via the Integrations
 * tab — main would keep reading the one we didn't write to.
 */
export function findMatrixRecord<T extends { id: string; label: string }>(records: readonly T[]): T | undefined {
  return (
    records.find((r) => r.id === MATRIX_INTEGRATION_ID) ??
    records.find((r) => r.label.trim().toLowerCase() === MATRIX_INTEGRATION_ID)
  );
}

/**
 * Build the integration record to upsert for the Matrix bot token.
 *
 * `kind`/`authType`/`authHeader` are seeded from the served template rather than
 * hand-authored: the template is what the broker expects, and upsert runs the
 * same fail-closed `validateIntegrationRecord` gate we run here — so a rejection
 * surfaces as an error the UI can show instead of a green "saved" over a write
 * that never landed.
 *
 * `baseUrl` is the CONFIGURED homeserver, not the template's blank default: the
 * broker forwards to `record.baseUrl` while credentials read the homeserver from
 * config, and the two drifting apart is a bot that authenticates against the
 * wrong origin.
 */
export function buildMatrixIntegrationRecord(input: {
  templates: readonly IntegrationTemplate[];
  records: readonly MatrixRecordLookup[];
  /** The homeserver URL as typed in Settings (trimmed here). */
  homeserverUrl: string;
  now: number;
}): { ok: true; record: IntegrationRecord } | { ok: false; error: string } {
  const template = input.templates.find((t) => t.idSuggestion === MATRIX_INTEGRATION_ID);
  if (!template) return { ok: false, error: 'the Matrix integration template is unavailable' };

  const baseUrl = input.homeserverUrl.trim();
  // Checked before validation so the message names the field the user can fix,
  // rather than the generic "baseUrl is required" from the shared validator.
  if (!baseUrl) return { ok: false, error: 'enter the homeserver URL first — the access token is stored against it' };

  const existing = findMatrixRecord(input.records);
  const id = existing?.id ?? template.idSuggestion;

  const candidate = {
    id,
    // Keep the existing label: when the record was found by the label ladder,
    // its label is the ONLY thing making main's fallback resolve it.
    label: existing?.label ?? template.label,
    kind: template.kind,
    baseUrl,
    authType: template.authType,
    authHeader: template.authHeader,
    secretRef: secretRefFor(id),
    // The consent gate main checks. Distinct from config.matrixEnabled: a
    // disabled record means the bot listens but can never reply.
    enabled: true
  };

  const validated = validateIntegrationRecord(candidate);
  if (!validated.ok) return { ok: false, error: validated.error };

  return {
    ok: true,
    record: {
      ...validated.value,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now
    }
  };
}
