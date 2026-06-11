// Sync health-check — probes every table and config key the reconcilers
// expect to exist before the sync runs. Catches "migration never ran" /
// "config key dropped" failure modes that otherwise hide for days because
// each reconciler swallows its own errors silently (so the daily cron
// stays green while one of its passes is broken).
//
// Returned shape:
//   {
//     ok: boolean,
//     missingTables: [{ table, error }],
//     missingConfig: [string],   // expected app_config keys with no value
//     checkedTables: number,
//     checkedConfig: number,
//   }
//
// When ok=false, sync-skybar.js prepends a ⚠️ block to the heartbeat Lark
// post so the admin channel sees the failure on the next cron tick.
//
// To add a new reconciler-required table or config key, append it here —
// keeping this file the single source of truth.

const REQUIRED_TABLES = [
  // Sync targets
  'package_orders', 'package_sales',
  // Order Workflow board (Sprint 7 + auto-status 017)
  'order_workflow',
  // Sub-source tables auto-status reads from
  'ticketing', 'manifest_passengers', 'vendor_payments', 'refunds', 'bk_groups',
  // Reconciler state tables (silent failure if missing)
  'balance_alert_state', 'tl_alert_state',
  'ticketing_alert_state', 'visa_alert_state',
  // Visa tracker source-of-truth
  'visa_tours',
  // Ticketing state-machine: peak season calendar
  'peak_periods',
  // BK details and tour catalog
  'bk_tours',
  // Frontend-required: WA group hybrid flow
  'staff_contacts', 'private_tours',
  // Global config
  'app_config',
];

const REQUIRED_CONFIG = [
  // Order Workflow team digests
  'lark_ticketing_url', 'lark_document_url', 'lark_cs_url', 'lark_ops_url',
  // TL Output H-14 / H-7 reminders
  'lark_tl_url',
  // Visa H-14 / H-7 reminders (sprint 11 #A)
  'lark_visa_url',
  // Deposit chase target for Ticketing state machine (sprint 11 #A v2)
  'lark_sales_url',
  // Sync heartbeat (sprint 11 #2 follow-up)
  'lark_admin_url',
];

async function validateSyncHealth(supabase) {
  // head=true returns no rows; '*' just asks "is the table reachable" without
  // assuming any specific column name (some tables PK on tour_code / bkg_no /
  // key etc., so '.select("id")' produces false negatives).
  const tableResults = await Promise.all(REQUIRED_TABLES.map(async t => {
    const { error } = await supabase.from(t).select('*', { count: 'exact', head: true });
    return { table: t, ok: !error, error: error ? error.message : null };
  }));
  const missingTables = tableResults.filter(r => !r.ok).map(r => ({ table: r.table, error: r.error }));

  const { data: cfg } = await supabase.from('app_config').select('key, value').in('key', REQUIRED_CONFIG);
  const cfgMap = Object.fromEntries((cfg || []).map(r => [r.key, r.value]));
  const missingConfig = REQUIRED_CONFIG.filter(k => !cfgMap[k]);

  return {
    ok: missingTables.length === 0 && missingConfig.length === 0,
    missingTables,
    missingConfig,
    checkedTables: REQUIRED_TABLES.length,
    checkedConfig: REQUIRED_CONFIG.length,
  };
}

// Renders the health block for the Lark heartbeat. Only emits content when
// something's wrong — clean state stays silent so the heartbeat stays short.
function healthHeartbeatBlock(health) {
  if (!health || health.ok) return '';
  const lines = ['⚠️ Health check failed:'];
  // When validateSyncHealth itself threw, sync-skybar passes { ok:false, error }
  // with no missingTables/missingConfig arrays. Guard with || [] (and surface the
  // raw error) so the heartbeat still posts — this is exactly the hard-failure
  // case the heartbeat exists to report.
  if (health.error) lines.push(`  • probe error: ${String(health.error).slice(0, 120)}`);
  for (const m of (health.missingTables || [])) lines.push(`  • table missing: ${m.table} (${(m.error || '').slice(0, 60)})`);
  for (const k of (health.missingConfig || [])) lines.push(`  • config missing: ${k}`);
  return lines.join('\n');
}

module.exports = { validateSyncHealth, healthHeartbeatBlock, REQUIRED_TABLES, REQUIRED_CONFIG };
