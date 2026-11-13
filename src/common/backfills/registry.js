import {
  consolidateLegacyTeamCredentials,
  consolidateLegacyTeamDeployments
} from '#/common/backfills/consolidate-legacy-team-data.js'
import {
  addTeamSlugs,
  snapshotCredentialProviderCloudAdapter
} from '#/common/backfills/per-document-backfills.js'
import { rewriteFailureTexts } from '#/common/backfills/failure-texts.js'
import { makeTeamMembersDirectoryOnly } from '#/common/backfills/team-members-directory-only.js'

const CREDENTIALS = 'credentials'
const MODELS = 'models'

/**
 * Ordered registry of one-off data backfills applied by `runBackfills` on
 * every server start. Each entry is applied at most once per environment
 * (tracked in the `schemaMigrations` collection), so `run` only needs to be
 * idempotent against documents it hasn't reached yet - not against re-runs
 * of the whole backfill.
 *
 * Add a new entry when a schema change needs existing documents updated to
 * the new shape (the "backfill" step of expand -> backfill -> contract).
 * Keep entries after they've shipped - they double as a changelog of what
 * ran, and re-ordering/removing a shipped entry has no effect since its id
 * is already recorded as applied.
 *
 * @type {Array<{
 *   id: string,
 *   description: string,
 *   run: (db: import('mongodb').Db) => Promise<object|void>
 * }>}
 */
export const backfillRegistry = [
  // Pre-refactor `teamDeployments` docs were one row per team+model+environment
  // with no `deployments[]` (see git history for the exact shape). The new
  // unique `{teamId, environment}` index means every model for a team+
  // environment must live in one document's `deployments[]` array instead -
  // this merges the legacy rows into that shape and renames the legacy
  // `dev` environment value to `sandbox` (Phase 1, confirmed 24 Sept 2026).
  // Must run before `createIndexes` creates that unique index (see
  // `src/plugins/mongodb.js`), since duplicate `{teamId, environment}` keys
  // across legacy rows would otherwise fail index creation.
  {
    id: '2026-09-25-consolidate-legacy-team-deployments',
    description:
      'Merges legacy one-row-per-model teamDeployments docs into one deployments[] doc per team+environment, renaming dev to sandbox',
    run: consolidateLegacyTeamDeployments
  },
  // Pre-refactor team credentials were one document per team+model (always
  // `type: 'apim-subscription'`, no `allowedDeployments`/`credentialType`).
  // The new one-credential-per-team+environment shape needs these merged:
  // keeps one canonical doc (the active one, or the most recent), merges
  // every legacy row's model into its `allowedDeployments`, sets
  // `credentialType: 'subscription-key'` (the only type that existed
  // before), renames `dev` to `sandbox`, retires the superseded rows, and
  // clears `expiresAt` (team credentials don't expire/renew - see
  // `credential-service.js`). Also seeds the matching `teamDeployments`
  // doc's `gateway.credentialType` so `reserveCredentialType` recognises
  // the team already uses `subscription-key`. Must run after the
  // `teamDeployments` consolidation above.
  {
    id: '2026-09-25-consolidate-legacy-team-credentials',
    description:
      'Merges legacy one-per-model team credentials into one per team+environment with allowedDeployments/credentialType, renaming dev to sandbox',
    run: consolidateLegacyTeamCredentials
  },
  // `environment` was added to every credential doc when Route 2 introduced
  // team-tier credentials; research-tier credentials issued before that
  // never got the field (nothing reads it today, but a future query/report
  // filtering by environment would silently skip these docs otherwise).
  {
    id: '2026-09-25-credentials-environment-default',
    description: 'Sets environment: null on credentials docs missing it',
    async run(db) {
      const { modifiedCount } = await db
        .collection(CREDENTIALS)
        .updateMany(
          { environment: { $exists: false } },
          { $set: { environment: null } }
        )

      return { modifiedCount }
    }
  },
  // The research-tier integration plan's Phase 1 added `issuerKey` so
  // lifecycle operations (renew/rotate/revoke/suspend) on an already-issued
  // credential know which `CredentialIssuer` adapter minted it, instead of
  // sniffing id prefixes. Every credential issued before this field existed
  // was minted by the mock issuer.
  {
    id: '2026-10-01-credentials-issuer-key-default',
    description: 'Sets issuerKey: "mock" on credentials docs missing it',
    async run(db) {
      const { modifiedCount } = await db
        .collection(CREDENTIALS)
        .updateMany(
          { issuerKey: { $exists: false } },
          { $set: { issuerKey: 'mock' } }
        )

      return { modifiedCount }
    }
  },
  // Phase 2 of the research-tier integration plan replaced the flat
  // `seedModels` re-seed with `syncCatalogue`, which writes `lifecycle`,
  // `catalogueSha` and `release` onto every synced model - fields pre-Phase-2
  // documents (the CDP dev environment holds real data) never had.
  {
    id: '2026-10-01-models-catalogue-metadata-default',
    description:
      'Sets default lifecycle/catalogueSha/release/syncedAt on models docs predating catalogue sync',
    async run(db) {
      const { modifiedCount } = await db.collection(MODELS).updateMany(
        { lifecycle: { $exists: false } },
        {
          $set: {
            lifecycle: { status: 'available', retirementDate: null },
            catalogueSha: null,
            release: null,
            syncedAt: null
          }
        }
      )

      return { modifiedCount }
    }
  },
  // `apimSubscriptionId` is being renamed to the provider-neutral
  // `externalGatewaySubscriptionId` (2 Oct 2026), since "APIM" stops being
  // accurate the moment a second `CredentialIssuer` provider exists. The old
  // field is kept (not unset) and still read as a fallback in
  // `credential-service.js`/`maintenance-service.js` until this has run
  // everywhere - this backfill only adds the new field alongside it.
  {
    id: '2026-10-02-credentials-external-gateway-subscription-id',
    description:
      'Copies apimSubscriptionId into the new externalGatewaySubscriptionId field on credentials docs missing it',
    async run(db) {
      const { modifiedCount } = await db
        .collection(CREDENTIALS)
        .updateMany({ externalGatewaySubscriptionId: { $exists: false } }, [
          { $set: { externalGatewaySubscriptionId: '$apimSubscriptionId' } }
        ])

      return { modifiedCount }
    }
  },
  // The catalogue now records which cloud and gateway adapter serves each
  // model (`cloud`/`adapter`), and credentials snapshot them at issue time.
  // Everything issued or synced before this was OpenAI on Azure via APIM.
  {
    id: '2026-10-07-models-cloud-adapter-default',
    description:
      'Sets cloud: "azure" and adapter: "azure-apim" on models docs missing them',
    async run(db) {
      const { modifiedCount } = await db
        .collection(MODELS)
        .updateMany(
          { adapter: { $exists: false } },
          { $set: { cloud: 'azure', adapter: 'azure-apim' } }
        )

      return { modifiedCount }
    }
  },
  {
    id: '2026-10-07-credentials-provider-cloud-adapter',
    description:
      'Snapshots provider/offering/cloud/adapter onto credentials docs missing them, from the credential model (azure/azure-apim if unknown)',
    run: snapshotCredentialProviderCloudAdapter
  },
  // Credentials now name their gateway `gateway`, matching the catalogue and
  // model documents. Expand step only: `adapter` is copied, not unset, because
  // an older instance still serving during a rolling deploy keeps writing
  // `adapter`. The later contract migration must re-copy any document still
  // missing `gateway` before it unsets `adapter`. Must stay after the two
  // 2026-10-07 entries above, which query and write the old `adapter` field.
  {
    id: '2026-10-08-credentials-gateway',
    description:
      'Copies adapter into gateway on credentials docs that have no gateway yet',
    async run(db) {
      const { modifiedCount } = await db
        .collection(CREDENTIALS)
        .updateMany({ gateway: { $exists: false } }, [
          { $set: { gateway: '$adapter' } }
        ])

      return { modifiedCount }
    }
  },
  // Models now carry a nested `hosting` object and `gateway` derived from the
  // catalogue offering, replacing the flat `cloud`/`adapter`. Must stay after
  // the two 2026-10-07 entries above, which read or write the flat model fields.
  {
    id: '2026-10-08-models-hosting-gateway',
    description:
      'Replaces flat cloud/adapter with nested hosting and gateway on models docs that have no gateway yet',
    async run(db) {
      const { modifiedCount } = await db
        .collection(MODELS)
        .updateMany({ gateway: { $exists: false } }, [
          {
            $set: {
              hosting: {
                platform: 'foundry',
                cloud: { $ifNull: ['$cloud', 'azure'] },
                provider: null
              },
              gateway: { $ifNull: ['$adapter', 'azure-apim'] }
            }
          },
          { $unset: ['cloud', 'adapter'] }
        ])

      return { modifiedCount }
    }
  },
  // Team deployment entries now record the TenantOrchestrator that
  // submitted them, and the GitOps sweep selects `orchestrator: 'github'`.
  // Everything submitted before WS5 went through the mock.
  {
    id: '2026-10-13-team-deployments-orchestrator',
    description:
      'Sets orchestrator: "mock" on teamDeployments entries missing it',
    async run(db) {
      const { modifiedCount } = await db
        .collection('teamDeployments')
        .updateMany(
          { deployments: { $elemMatch: { orchestrator: { $exists: false } } } },
          { $set: { 'deployments.$[entry].orchestrator': 'mock' } },
          { arrayFilters: [{ 'entry.orchestrator': { $exists: false } }] }
        )

      return { modifiedCount }
    }
  },
  // Every team now carries the immutable `slug` that names its GitOps file,
  // its gateway API path and its model deployments. Teams created before it
  // existed get one derived from their name here, document by document
  // because each has to be checked against the slugs already taken - and
  // before `createIndexes` adds the unique index on it.
  {
    id: '2026-10-14-add-team-slug',
    description: 'Derives slug from name on teams docs missing it',
    run: addTeamSlugs
  },
  // A team's Entra app registration identifiers now come off its run report
  // onto `oauthClient.registration` when a deployment verifies, for the Graph
  // issuer (B18). Teams that verified earlier already hold the report's
  // resources on a deployment entry, so take them from there; null where
  // Entra skipped the registration or nothing has verified yet.
  {
    id: '2026-10-19-team-deployments-oauth-registration',
    description:
      'Sets oauthClient.registration on teamDeployments docs missing it, from a deployment entry’s run report resources, else null',
    async run(db) {
      const { modifiedCount } = await db
        .collection('teamDeployments')
        .updateMany({ 'oauthClient.registration': { $exists: false } }, [
          {
            $set: {
              'oauthClient.registration': {
                $let: {
                  vars: {
                    found: {
                      $first: {
                        $filter: {
                          input: {
                            $map: {
                              input: { $ifNull: ['$deployments', []] },
                              as: 'entry',
                              in: '$$entry.gitops.resources.registration'
                            }
                          },
                          as: 'candidate',
                          cond: {
                            $ne: [{ $type: '$$candidate.object_id' }, 'missing']
                          }
                        }
                      }
                    }
                  },
                  in: {
                    $cond: [
                      { $ne: [{ $type: '$$found.object_id' }, 'missing'] },
                      {
                        clientId: '$$found.client_id',
                        objectId: '$$found.object_id',
                        servicePrincipalObjectId:
                          '$$found.service_principal_object_id'
                      },
                      null
                    ]
                  }
                }
              }
            }
          }
        ])

      return { modifiedCount }
    }
  },
  // A research credential now records the environment it was issued in, and
  // every lifecycle call (renew, rotate, revoke, suspend, reveal, vault) reads
  // it instead of the single hand-built environment the flat configuration
  // described. Every research credential that exists today was minted against
  // those hand-built resources, which `AIP_ENVIRONMENTS` names `sandbox`.
  // `environmentOf()` in credential-service.js reads the same value for a
  // document this has not reached yet. Must stay after
  // 2026-09-25-credentials-environment-default, which sets the null it matches.
  {
    id: '2026-10-20-research-credentials-environment',
    description:
      'Sets environment: "sandbox" on research credentials docs with no environment',
    async run(db) {
      const { modifiedCount } = await db
        .collection(CREDENTIALS)
        .updateMany({ tier: 'research', environment: null }, [
          { $set: { environment: 'sandbox' } }
        ])

      return { modifiedCount }
    }
  },
  // Failure texts stored on entries say what the platform engineers were told
  // and name Azure; they now only say what failed, and the page says to contact
  // AI Platform Support. Nothing re-projects a timed-out entry, so its stored
  // text would otherwise stay as it was.
  {
    id: '2026-11-02-team-deployments-failure-wording',
    description:
      'Rewrites the old failure texts on teamDeployments entries (platform engineers alerted, Azure) to the current wording',
    run: rewriteFailureTexts
  },
  // Team membership is by person from the directory only: invitations, the
  // `email` on a membership and both email binds at sign-in are gone, so
  // existing data is brought to that shape (invitations removed, one active
  // membership per person and team, `email` unset, people with no `oid`
  // deleted). Runs before `createIndexes`, whose unique index on active
  // memberships would otherwise refuse to build over duplicates. It also sets
  // `requestedRole` (the role an add was requested with, kept with its
  // Idempotency-Key) from `role` for memberships that carry a key.
  {
    id: '2026-11-03-team-members-directory-only',
    description:
      'Removes team invitations, keeps one active membership per person and team, unsets teamMembers.email, sets requestedRole on memberships with an idempotencyKey and deletes users with no oid',
    run: makeTeamMembersDirectoryOnly
  },
  // The Platform Admin Teams list filters and counts by `teams.status`
  // (`active`, `disabled`, `pending-removal`), so every team that predates it
  // gets `active`. Readers still treat an absent status as active
  // (`team-status.js`), and `createTeam` writes it from now on.
  {
    id: '2026-11-12-teams-status-default',
    description: 'Sets status: "active" on teams docs missing it',
    async run(db) {
      const { modifiedCount } = await db
        .collection('teams')
        .updateMany(
          { status: { $exists: false } },
          { $set: { status: 'active' } }
        )

      return { modifiedCount }
    }
  }
]
