# Vision v2 — backup, recovery, migration and operations

**Status:** technical runbook and migration plan for the loopback-only local Compose stack; includes a tested SQLite importer (not yet rehearsed on a disposable PG16/MinIO target) and a rehearsal runbook for the owner ([`PLATFORM-REHEARSAL.md`](PLATFORM-REHEARSAL.md)). It is not a production backup policy, a production restore rehearsal, an approved SQLite cutover, or permission to accept/publicly publish user-generated music.

The v2 platform remains isolated from the legacy SQLite personal-library server. Keep registration and uploads disabled outside approved synthetic tests. An ingest fingerprint status of `not_configured` is not a rights clearance.

## 1. Scope and backup contents

`npm run platform:local:backup` creates a private, versioned directory bundle containing:

- a PostgreSQL custom-format `pg_dump` archive;
- a recursive copy of the private MinIO bucket;
- a Redis RDB snapshot, including BullMQ queue and rate-limit state;
- a manifest with SHA-256 hashes, byte counts, object keys and the bucket name.

The API and worker are stopped before the three data stores are snapshotted, preventing new application writes while the bundle is assembled. If they were running, a normal backup restarts the same services afterward. The command verifies the archive listing, object-key allowlist and each file hash before reporting success.

Backups do **not** include `.env.platform.local`, credentials, container images, logs, or the legacy SQLite library. Backup directories live under `backups/platform-v2/` and are Git-ignored. Treat them as sensitive: they contain private audio, account/catalog metadata, audit data and queue payloads. Copy a production backup to encrypted, access-controlled off-host storage; local copies on the same disk do not protect against disk loss. No retention schedule, RPO, RTO, remote target or production key-management policy is approved by this document.

The snapshot is for the local development Compose stack only. It depends on the pinned local PostgreSQL, MinIO and Redis images and does not establish provider portability.

## 2. Local snapshot and restore

Start the isolated stack first; do not run the legacy `npm start` server against platform storage.

```powershell
npm run platform:local:up
npm run platform:local:status
npm run platform:local:backup
# Optional explicit destination, relative to the repository root:
npm run platform:local:backup -- backups/platform-v2/before-local-test
```

The command refuses to overwrite an existing destination and requires running `database`, `redis` and `storage` Compose services. Check that it reports database/Redis sizes and S3 object count. Move any backup that must survive machine/repository loss to secure storage outside the clone.

Restore is deliberately explicit and destructive to the current local platform state:

```powershell
npm run platform:local:restore -- backups/platform-v2/before-local-test --confirm
```

Before replacement the command validates the manifest, bucket/database names, object-key paths, SHA-256 hashes, PostgreSQL archive listing and Redis RDB; it also creates a **pre-restore safety backup** of the current state. It restores Redis state (including its local AOF reset), mirrors the exact S3 object set, recreates the target database, then restores the PostgreSQL archive in a single transaction. `api` and `worker` remain stopped on success so an operator can inspect the result. Resume through the normal migration/start path:

```powershell
npm run platform:local:up
Invoke-RestMethod http://127.0.0.1:4400/api/v2/health
npm run platform:local:status
```

`up` reapplies only forward PostgreSQL migrations shipped by the checked-out code. Compare the resulting migration name with `/api/v2/health`, check an expected synthetic catalog record and private-media access, and inspect logs before continuing work.

If a restore command fails after any data component has been changed, do not start the API or worker. Keep the services stopped, inspect `npm run platform:local:status` and `npm run platform:local:logs`, then either rerun the same verified restore or restore the automatically created `pre-restore-*` bundle. Do not hand-delete Redis AOF files, run `docker compose down -v`, or copy PostgreSQL/MinIO volume directories as a substitute for a logical snapshot.

### Application rollback

Platform migrations are forward-only. Do not assume that checking out an older application revision is safe against a newer database schema. For a code-only rollback, first verify that the old application supports the current schema. If not, stop API and worker and restore the **matching PostgreSQL + MinIO + Redis bundle** taken before the deployment; then run the matching previous code. Never restore only the database or only the object bucket. Preserve the pre-rollback bundle until data and service health have been checked. This is a runbook recipe, not an exercised rollback rehearsal.

### Failure and recovery checks

Use the loopback-only API health endpoint and the worker's private Compose health endpoint. The worker health response includes PostgreSQL/Redis/MinIO/worker readiness and its latest outbox/sweep status; do not expose worker port 4401 outside the Compose network.

Read-only diagnostic SQL (run inside the database service with local operator credentials):

```sql
SELECT status, visibility, count(*)
FROM tracks GROUP BY status, visibility ORDER BY status, visibility;

SELECT topic,
       count(*) FILTER (WHERE processed_at IS NULL AND dead_lettered_at IS NULL) AS pending,
       count(*) FILTER (WHERE dead_lettered_at IS NOT NULL) AS dead_lettered
FROM platform_outbox GROUP BY topic ORDER BY topic;

SELECT count(*) AS expired_pending_uploads
FROM upload_intents WHERE status = 'pending' AND expires_at <= now();

SELECT fingerprint->>'status' AS fingerprint_status, count(*)
FROM tracks WHERE status IN ('quarantine', 'in_review', 'published')
GROUP BY fingerprint->>'status' ORDER BY fingerprint_status;

SELECT status, count(*) FROM rights_claims GROUP BY status ORDER BY status;
```

Use `npm run platform:local:logs` for the JSON API/worker and infrastructure logs. Correlate an API failure by the returned `X-Request-Id`; never send `.env.platform.local`, bearer tokens, upload URLs, or real audio in a bug report.

## 3. SQLite → PostgreSQL migration plan (proposal, not executed)

SQLite v1 is a single-owner personal-library application. v2 is a multi-user music platform with explicit owner, rights-confirmation, quarantine, moderation and publication states. They are not interchangeable schemas and **must not be merged by table-name similarity**. A read-only aggregate inventory command (`scripts/platform-sqlite-audit.mjs`) and a separate reviewable importer (`scripts/platform-sqlite-import.mjs`, dry-run by default, PGlite-tested) exist; no dual-write mode or cutover has been executed or approved.

### 3.1 Preserve source and define the allowed dataset

1. Obtain an explicit owner decision on whether any legacy personal-library data should be copied. The default is **no import**; keep the v1 library and its normal verified SQLite backup intact.
2. Produce and verify a fresh legacy backup using the existing v1 backup path (`services/api/src/backup.js` via the legacy `/api/backups` route or its schedule, or `scripts/backup.sh` followed by `scripts/verify-backup.mjs`); do not copy a live SQLite database file while WAL writes are active. Keep that archive immutable and separate from the v2 backup bundle.
3. Run the read-only inventory against an **unpacked, verified backup directory** (never the live database). First validate the archive, then extract it to a private staging folder and pass the folder containing `vision.db`:

   ```powershell
   $archive = Read-Host 'Path to the legacy backup .tar.gz'
   node scripts/verify-backup.mjs $archive
   if ($LASTEXITCODE -ne 0) { throw 'Legacy backup verification failed' }
   $stage = Join-Path $env:TEMP ('vision-sqlite-audit-' + [guid]::NewGuid().ToString())
   New-Item -ItemType Directory -Path $stage | Out-Null
   try {
     tar -xzf $archive -C $stage
     if ($LASTEXITCODE -ne 0) { throw 'Legacy backup extraction failed' }
     $bundle = $stage
     if (-not (Test-Path (Join-Path $bundle 'vision.db'))) {
       $backupDirectories = @(Get-ChildItem -Path $stage -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'vision.db') })
       if ($backupDirectories.Count -ne 1) { throw 'Expected exactly one extracted directory containing vision.db' }
       $bundle = $backupDirectories[0].FullName
     }
     npm run platform:sqlite:audit -- $bundle
     if ($LASTEXITCODE -ne 0) { throw 'SQLite inventory failed or integrity_check was not clean' }
   } finally {
     Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
   }
   ```

   The tool opens SQLite read-only and rejects WAL/journal sidecars; its JSON report contains aggregate table/track/media counts, migration IDs, the database hash, checksum/size/missing-file findings and foreign-key violations. It does not emit titles, track IDs, paths, URLs, comments, tokens or crash text; it does not write to source or target and does not approve migration. Store the report privately because hashes/counts can still identify a dataset.
4. Choose the exact subset and target owner account. Only after that explicit decision, the approved rehearsal may use the implemented importer (`scripts/platform-sqlite-import.mjs`); any deterministic source-to-target ID map it needs stays in a private staging area, not Git. No other user's or third-party music may be imported by inference. Before any public state, the target owner must make the current explicit rights confirmation and the content must pass v2 moderation; no legacy `liked`, `plays`, filename or prior state is evidence of rights or approval.

### 3.2 Candidate data disposition

| Legacy SQLite data | Proposed handling | Guardrail |
|---|---|---|
| `tracks`, `blobs`, `track_variants`, `blob_seeds`, `media/`, `covers/` | Candidate metadata/media for an owner-approved private import; use the normal checksum, audio validation and quarantine ingest path. Rebuild variants and blob availability rather than trusting stale derived rows. | Keep private/quarantined. Verify SHA-256, byte count and media existence; do not copy filesystem paths into public rows. Importer exists (`scripts/platform-sqlite-import.mjs`); rehearsal pending. |
| `playlists`, `playlist_tracks`, `smart_playlists` | Retain in the v1 archive until v2 private-playlist semantics and ownership/mapping are accepted. | Do not turn them into public catalog or radio schedules. |
| `listens`, `listen_events`, `tracks.plays`, `tracks.liked` | Do not migrate by default. If later approved, define a privacy/analytics mapping and mark imported aggregates as historical/unverified. | Legacy playback lacks v2 user/session/capability evidence; never synthesize v2 verified play events from counters. |
| `external_tracks` | Keep in the v1 archive; review links and rights separately before any future import. | Do not copy external audio or treat embed metadata as permission. |
| `shares`, `share_hits`, `share_comments`, `audit_log` | Exclude from v2 import. Retain only under the existing v1 backup/access/retention policy pending privacy/legal review. | Do not migrate share tokens, guest comments, free-text audit context, or pseudonymous IP hashes into user-facing v2 data. |
| `library_devices`, `library_tracks`, `library_files` | Exclude unless the owner explicitly selects a bounded subset and approves a device/owner mapping. | Device names, file paths and sync rows do not establish a v2 account owner or rights. |
| `crash_reports` | Exclude. | Free-text errors/context may contain identifiers or secrets; no v2 crash-report import contract exists. |

### 3.3 Rehearsal, reconciliation and cutover gates

The importer (`scripts/platform-sqlite-import.mjs`) is a separate, reviewable tool and maps onto stages 1–3 below (dry-run report; validation of checksum/size/type/metadata; private quarantine load through the owner upload → checksum → quarantine → worker ingest path). It is idempotent by SHA-256 (re-running reports `already_imported`), writes no public state, approves nothing and emits a PII-free JSON report (`--report`). It does not perform stages 4–7: rehearsal must run against a disposable PostgreSQL 16 + pgvector and MinIO, never production first, per the runbook in [`PLATFORM-REHEARSAL.md`](PLATFORM-REHEARSAL.md) §E. Stages:

1. **Dry-run extract:** read a verified SQLite snapshot; emit a report only. Record source schema/migration IDs, eligible row counts, duplicate checksums, missing media and excluded tables.
2. **Transform:** stable ID mapping; explicit target owner; normalized metadata and dates; bounded text; no old access tokens/secrets. Validate all target constraints before writing.
3. **Private load:** implemented as `scripts/platform-sqlite-import.mjs --apply`: creates new v2 records through the owner upload → checksum verification → private quarantine → worker ingest path and enqueues the normal outbox. Do not insert `published` rows or fabricate moderation approvals. The import flow records `album`/`genre` after ingest and leaves tracks unprocessed/quarantine until the worker runs.
4. **Reconcile:** compare source-eligible vs loaded counts by disposition; compare every imported audio SHA-256 and byte length; verify no duplicate/missing target IDs, dangling references, public visibility, unapproved moderation decisions or unresolved claims. Save machine-readable and human-readable reports with no PII.
5. **Owner review:** manually inspect metadata and sample playback from private objects. Each track requires a current rights acknowledgement and moderator decision before any public catalog entry. `not_configured` fingerprint remains an unresolved technical status, not a rights finding.
6. **Cutover:** only after explicit owner/legal/operations approval. Freeze v1 writes for the final snapshot, load the exact approved delta, reconcile again, and keep v1 read-only and restorable. Do not dual-write between SQLite and PostgreSQL.
7. **Rollback:** because v1 remains untouched, disable v2 and resume the original SQLite app from its verified archive. If the v2 target must be reset, restore its matching PG/S3/Redis snapshot or discard the disposable target. Never reverse-migrate by deleting v2 rows or reconstructing SQLite from a partially imported database.

Required reconciliation evidence is a versioned report of source schema, selected/excluded table counts, row-disposition totals, media count/bytes/hash matches, target private/quarantine counts, rights/moderation state, unmatched references, and reviewer/date. Zero missing files and zero unexplained count/hash differences are required; the numeric thresholds and actual import cohort require owner approval.

## 4. Observability and operator signals

- **API readiness:** `GET /api/v2/health` checks current schema migration and rate-limit readiness; `503` is not ready. The endpoint does not prove production storage, moderation/legal readiness or a restore.
- **Worker readiness:** internal `http://worker:4401/health` probes PostgreSQL, Redis and the MinIO bucket, reports worker state, and exposes the last successful outbox cycle/error code and upload-expiry sweep. Compose health checks it; port 4401 is not published to the host.
- **Prometheus text metrics:** `GET /metrics` exposes bounded-cardinality HTTP request counters and latency histogram. Configure a random `PLATFORM_METRICS_TOKEN` of at least 32 bytes and scrape with `Authorization: Bearer ...`. The endpoint is hidden (404) when no token is configured and also returns 404 for a bad token. Do not publish the metrics endpoint or put the token in a URL.
- **Structured logs:** API access entries contain request ID, method, route template, status and duration only; no raw path IDs, query strings, request bodies, IPs, emails or authorization headers. Worker events include job type/ID, status, attempt counts and sanitized error codes. Use request IDs to correlate API failures; do not treat logs as a durable audit store (moderation/rights transitions have PostgreSQL audit records).
- **Database-level checks:** use the read-only queries above for outbox backlog/dead letters, expired upload intents, quarantine/in-review/published counts and rights claims. Keep query output private because it describes platform content/state.
- **Alerting example:** `deploy/observability/prometheus-alerts.example.yml` holds starter rules (target down, 5xx > 5%, p95 > 1.5s, sustained 429) against `vision_platform_http_requests_total` / `vision_platform_http_request_duration_seconds`. Nothing is applied automatically; thresholds are placeholders until the owner sets SLOs/retention/contacts (turnkey wiring: [`PLATFORM-REHEARSAL.md`](PLATFORM-REHEARSAL.md) §D). Outbox/DLQ alerts need a blackbox SQL exporter that does not exist yet — manual SQL until then (known gap).

This implementation supplies signals, not a production alert policy. Set service-specific SLOs, retention, log access, escalation contacts and alert thresholds only after the operator and legal/privacy review are assigned. A green health check or low HTTP latency does not prove UGC rights, successful recovery, anti-fraud, or production acceptance.

## 5. Acceptance ledger

| Check | Current state | Evidence needed to close |
|---|---|---|
| Backup bundle generation and file-hash verification | Implemented; bundle verifier covered by local Node tests. Docker commands not run in this workspace. Turnkey owner steps: [`PLATFORM-REHEARSAL.md`](PLATFORM-REHEARSAL.md) §A/B. | Owner-run Windows Compose backup; verify manifest and copy the bundle off-device securely. |
| Restore/rollback recipe | Implemented with mandatory `--confirm` and automatic pre-restore backup. No real restore has been run. | Restore into disposable Windows volumes; check PostgreSQL health/migration, Redis queue recovery, object count/hash and private media; then rehearse rollback (runbook §B). |
| Full upload → quarantine → ingest → rights submission → moderation → publication | Synthetic end-to-end HTTP test exists on PGlite with memory S3 and fake transcoder. | CI matrix is green on the branch tip (`113a9cf`, run 44688680838: Platform integration job on PostgreSQL 16 + pgvector, Redis 7.4, MinIO; 2026-11-12). Owner repeats per runbook §B/C; the approved real transcoder is still an open decision before Stack Ready acceptance. |
| SQLite → PostgreSQL data migration | Importer implemented and automated-tested (dry-run report, apply via quarantine ingest, SHA-256 idempotency, explicit skip dispositions, owner artist/admin role required); source inventory read-only; no cutover performed. | Owner dataset decision; privacy/legal review; disposable PG16/MinIO rehearsal and signed reconciliation (runbook §E); per-track rights acknowledgement and moderation before any public state. |
| Metrics/log/health signals | API JSON logs, token-gated HTTP metrics and richer worker health implemented; starter alert rules at `deploy/observability/prometheus-alerts.example.yml`; no hosted monitoring or alerts configured. | Owner-run wiring, privacy/retention review, thresholds/SLOs, access controls and incident drill (runbook §D). |
| Owner Stack Ready acceptance (ADR-0021) | **Not accepted.** Technical implementation exists; owner rehearsals and sign-off are outstanding. | Every row above closed on the owner's machine plus an explicit owner decision recorded in `ROADMAP-v2.md` §17.4. Gate does not replace legal/consent gates. |

Until those external rehearsals and owner decisions are recorded, Stack Ready, public UGC, external invitations and production readiness remain **not accepted**.
