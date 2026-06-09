// Sign in as each role and test the write that previously failed.
import { createClient } from '@supabase/supabase-js';
const URL = process.env.SUPABASE_URL;
const ANON = 'sb_publishable_n7eDoUrf9cRAzX4eKjl9Tg_CHLD-mbk';
const PASSWORD = 'Webuy@2026';

const tests = [
  { user: 'fita',   role: 'cs',        op: async (sb,u) => {
    const id = 'rls-test-cs-'+Date.now();
    const { error } = await sb.from('cs_records').upsert({id,tour:'TEST',dep:'2026-12-31',tl:'-',notes:'rls test'},{onConflict:'id'});
    if (!error) await sb.from('cs_records').delete().eq('id', id);
    return error;
  }},
  { user: 'lodan',  role: 'doc',       op: async (sb,u) => {
    // Try the visa_check_ext app_config write that was failing
    const { error } = await sb.from('app_config').upsert({key:'visa_check_ext_test', value:{ok:true}},{onConflict:'key'});
    if (!error) await sb.from('app_config').delete().eq('key', 'visa_check_ext_test');
    return error;
  }},
  { user: 'lodan',  role: 'doc',       op: async (sb,u) => {
    // Try updating a manifest_passenger
    const { data: any } = await sb.from('manifest_passengers').select('id').limit(1);
    if (!any?.length) return { message: '(no manifest rows to test)' };
    const { error } = await sb.from('manifest_passengers').update({ visa_remark: 'rls test '+Date.now() }).eq('id', any[0].id);
    return error;
  }},
  { user: 'alma',   role: 'ticketing', op: async (sb,u) => {
    const { data: any } = await sb.from('manifest_passengers').select('id').limit(1);
    if (!any?.length) return { message: '(no manifest rows)' };
    const { error } = await sb.from('manifest_passengers').update({ is_tour_leader: false }).eq('id', any[0].id);
    return error;
  }},
  { user: 'agatha', role: 'ops',       op: async (sb,u) => {
    const { error } = await sb.from('app_config').upsert({key:'rls_test_ops', value:'1'},{onConflict:'key'});
    if (!error) await sb.from('app_config').delete().eq('key', 'rls_test_ops');
    return error;
  }},
];

for (const t of tests) {
  const sb = createClient(URL, ANON);
  const { data: auth, error: aerr } = await sb.auth.signInWithPassword({ email: `${t.user}@webuy.local`, password: PASSWORD });
  if (aerr) {
    console.log(`  ${t.user.padEnd(8)} (${t.role}) LOGIN FAIL: ${aerr.message}`);
    continue;
  }
  const e = await t.op(sb, auth.user);
  console.log(`  ${t.user.padEnd(8)} (${t.role}) → ${e ? '❌ ' + (e.message||JSON.stringify(e)).slice(0,120) : '✅ OK'}`);
  await sb.auth.signOut();
}
