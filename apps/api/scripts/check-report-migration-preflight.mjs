import { PrismaClient } from "@prisma/client";

const migrations = [
  "20260912_statistics_p2_reports",
  "20260913_report_object_cleanup_ledger",
  "20260914_report_delete_tombstone_guard",
  "20260927090000_pdf_only_energy_reports"
];
const phase = process.argv[2] ?? "--phase=pre";
const issues = [];
const flag = code => { if (!issues.some(issue => issue.code === code)) issues.push({ code }); };
let prisma;

try {
  if (!process.env.DATABASE_URL || !["--phase=pre", "--phase=post"].includes(phase) || process.argv.length > 3) {
    flag("invalid_configuration");
  } else {
    // Never load a local .env or migrate/resolve here. The caller must explicitly
    // select the target. PostgreSQL enforces read-only across every inspection.
    prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [] });
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1s'");
      const query = sql => tx.$queryRawUnsafe(sql);
      const [catalog] = await query(`SELECT
        to_regclass('"_prisma_migrations"') IS NOT NULL AS history,
        to_regclass('"SiteDeletionCleanup"') IS NOT NULL AS legacy,
        to_regclass('"EnergyReportJob"') IS NOT NULL AS job,
        to_regclass('"EnergyReportObjectCleanup"') IS NOT NULL AS cleanup`);
      const history = catalog.history ? await query('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"') : [];
      if (history.some(row => !row.finished_at && !row.rolled_back_at)) flag("unfinished_migration");
      const applied = migrations.map(name => history.some(row => row.migration_name === name && row.finished_at && !row.rolled_back_at));
      if ((applied[1] && !applied[0]) || (applied[2] && !applied[1]) || (applied[3] && !applied[2])) flag("migration_history_gap");
      if (phase === "--phase=post" && applied.some(value => !value)) flag("report_migrations_pending");

      const types = await query(`SELECT typname FROM pg_type WHERE typnamespace = current_schema()::regnamespace
        AND typname IN ('EnergyReportStatus', 'EnergyReportFormat')`);
      const functions = await query(`SELECT proname FROM pg_proc WHERE pronamespace = current_schema()::regnamespace
        AND proname IN ('guard_energy_report_snapshots', 'preserve_energy_report_object_tombstone')`);
      if ((!applied[0] && (catalog.job || types.length || functions.some(row => row.proname === 'guard_energy_report_snapshots')))
        || (!applied[1] && catalog.cleanup)
        || (!applied[2] && functions.some(row => row.proname === 'preserve_energy_report_object_tombstone'))) flag("unexpected_report_catalog");
      if ((applied[0] && (!catalog.job || types.length !== 2)) || (applied[1] && !catalog.cleanup)) flag("report_catalog_missing");

      if (phase === "--phase=post" && applied[3]) {
        // This is the immediate post-reset gate, before new PDF jobs are accepted.
        // Later routine preflights permit legitimate new report rows.
        if (catalog.job) {
          const [rows] = await query('SELECT count(*)::int AS count FROM "EnergyReportJob"');
          if (rows.count !== 0) flag("report_history_not_empty");
        }
        const formatLabels = await query(`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typnamespace = current_schema()::regnamespace AND t.typname = 'EnergyReportFormat'
          ORDER BY e.enumsortorder`);
        if (formatLabels.length !== 1 || formatLabels[0].enumlabel !== "pdf") flag("report_format_not_pdf_only");
      }

      const constraints = await query(`SELECT conname FROM pg_constraint WHERE connamespace = current_schema()::regnamespace AND convalidated`);
      const expectedChecks = [
        ...(applied[0] ? ["EnergyReportJob_progress_check", "EnergyReportJob_attempt_check", "EnergyReportJob_lease_check", "EnergyReportJob_hash_check", "EnergyReportJob_snapshot_check", "EnergyReportJob_object_check", "EnergyReportJob_status_state_check", "EnergyReportJob_deletion_check"] : []),
        ...(applied[1] ? ["EnergyReportObjectCleanup_lease_pair", "EnergyReportObjectCleanup_keys"] : [])
      ];
      if (expectedChecks.some(name => !constraints.some(row => row.conname === name))) flag("report_constraint_missing");
      const indexes = await query(`SELECT indexrelid::regclass::text AS name FROM pg_index
        WHERE indrelid = to_regclass('"EnergyReportJob"') AND indisvalid AND indisunique`);
      if (applied[0] && !indexes.some(row => row.name.replaceAll('"', '') === 'EnergyReportJob_active_request_key')) flag("active_request_index_missing");
      const triggers = await query(`SELECT t.tgname, t.tgenabled, t.tgtype, p.proname FROM pg_trigger t
        JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = to_regclass('"EnergyReportJob"') AND NOT t.tgisinternal`);
      const guardPresent = (name, fn, type) => triggers.some(row => row.tgname === name
        && ["O", "A"].includes(row.tgenabled) && row.tgtype === type && row.proname === fn);
      if (applied[0] && !guardPresent("EnergyReportJob_snapshot_immutable", "guard_energy_report_snapshots", 19)) flag("snapshot_trigger_missing_or_disabled");
      if (applied[2] && !guardPresent("EnergyReportJob_preserve_objects_before_delete", "preserve_energy_report_object_tombstone", 11)) flag("delete_trigger_missing_or_disabled");

      if (catalog.legacy) {
        const [shape] = await query(`SELECT count(*)::int AS invalid FROM "SiteDeletionCleanup"
          WHERE jsonb_typeof("objectKeys") IS DISTINCT FROM 'array'`);
        if (shape.invalid) flag("legacy_object_keys_not_array");
        // CASE protects jsonb_array_elements_text from scalars without relying
        // on planner predicate order. Expansion matches migration 20260913.
        const groups = `WITH expanded AS (
          SELECT split_part(key, '/', 3) AS report_id, split_part(key, '/', 2) AS site_id,
            jsonb_agg(DISTINCT format('reports/%s/%s/attempt-%s.%s', split_part(key, '/', 2), split_part(key, '/', 3), attempt, split_part(key, '.', 2))) AS keys
          FROM "SiteDeletionCleanup",
            jsonb_array_elements_text(CASE WHEN jsonb_typeof("objectKeys") = 'array' THEN "objectKeys" ELSE '[]'::jsonb END) AS keys(key),
            generate_series(1, 3) AS attempt
          WHERE key ~ '^reports/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/attempt-[1-3]\\.(xlsx|pdf)$'
          GROUP BY split_part(key, '/', 3), split_part(key, '/', 2)
        )`;
        const [expansion] = await query(`${groups} SELECT
          (SELECT count(*)::int FROM expanded WHERE jsonb_array_length(keys) > 3) AS oversized,
          (SELECT count(*)::int FROM (SELECT report_id FROM expanded GROUP BY report_id HAVING count(*) > 1) duplicates) AS conflicts`);
        if (expansion.oversized) flag("legacy_report_key_count_exceeded");
        if (expansion.conflicts) flag("legacy_report_identity_conflict");
        if (applied[1] && catalog.cleanup) {
          const [backfill] = await query(`${groups} SELECT count(*)::int AS missing FROM expanded e
            LEFT JOIN "EnergyReportObjectCleanup" c ON c."reportId" = e.report_id
            WHERE c."reportId" IS NULL OR c."siteId" <> e.site_id OR NOT c."objectKeys" @> e.keys`);
          if (backfill.missing) flag("legacy_report_backfill_missing");
        }
      }
    }, { isolationLevel: "RepeatableRead", timeout: 30_000 });
  }
} catch {
  // Connection/catalog/timeout errors are blockers; never print raw DB errors,
  // URLs, credentials or legacy private object paths into deployment logs.
  flag("inspection_failed");
} finally {
  await prisma?.$disconnect();
}

console.log(JSON.stringify({ ok: issues.length === 0, phase: phase.replace("--phase=", ""), issues }));
process.exitCode = issues.length ? 1 : 0;
