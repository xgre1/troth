// SPDX-License-Identifier: AGPL-3.0-only
// Per-service API wrappers.
//
// Thin named-tool layer on top of api_call.js for the operations the
// partner uses often enough that a dedicated schema beats consulting
// chameleon-ingested OpenAPI docs (implementation step) every time.
//
// Design rule:
//   - Each wrapper is ≤ 30 LOC.
//   - Each wrapper validates only what api_call doesn't (service-
//     specific shape: e.g. supabase_run_sql requires `query`).
//   - All auth + URL building + response handling delegate to api_call.
//   - Wrappers DO NOT expand the service registry — they reuse the
//     registry baked into api-call.js.
//
// v1 wrappers (5; high-frequency, low-risk):
//   github_get_repo        (read)
//   github_create_issue    (write — reversible)
//   vercel_list_projects   (read)
//   notion_search          (read)
//   supabase_run_sql       (write — needs PostgREST endpoint or RPC)
//
// Deferred to v2 (added on demand when goals hit them):
//   github_create_repo / github_create_pr / vercel_deploy
//   openai_chat / anthropic_messages   (transports already exist)
//   gmail_search / gmail_send          (extended tools module)
//   twilio_sms_send / cloudflare_*      (Phase 5)
//   stripe_create_charge                (Phase 6 spend_authority)
//
// design grounding: same as api-call.js — R17 credential wall, R23
// audience='external' on responses, CaMeL untrusted-input principle.

'use strict';

const apiCall = require('./api-call.js');

// GitHub: GET /repos/{owner}/{repo}
async function github_get_repo(args, ctx) {
  if (!args || !args.owner || !args.repo) {
    return { ok: false, refused: true, reason: 'owner_and_repo_required' };
  }
  return apiCall.apiCall({
    service: 'github',
    method:  'GET',
    path:    '/repos/' + encodeURIComponent(args.owner) + '/' + encodeURIComponent(args.repo),
    credential_name: args.credential_name || 'GITHUB_TOKEN',
    timeout_ms: args.timeout_ms
  }, ctx);
}

// GitHub: POST /repos/{owner}/{repo}/issues
async function github_create_issue(args, ctx) {
  if (!args || !args.owner || !args.repo || !args.title) {
    return { ok: false, refused: true, reason: 'owner_repo_title_required' };
  }
  return apiCall.apiCall({
    service: 'github',
    method:  'POST',
    path:    '/repos/' + encodeURIComponent(args.owner) + '/' + encodeURIComponent(args.repo) + '/issues',
    body:    { title: args.title, body: args.body || '', labels: args.labels || [], assignees: args.assignees || [] },
    credential_name: args.credential_name || 'GITHUB_TOKEN',
    timeout_ms: args.timeout_ms
  }, ctx);
}

// Vercel: GET /v9/projects
async function vercel_list_projects(args, ctx) {
  args = args || {};
  const query = {};
  if (args.limit) query.limit = args.limit;
  if (args.team_id) query.teamId = args.team_id;
  return apiCall.apiCall({
    service: 'vercel',
    method:  'GET',
    path:    '/v9/projects',
    query,
    credential_name: args.credential_name || 'VERCEL_TOKEN',
    timeout_ms: args.timeout_ms
  }, ctx);
}

// Notion: POST /v1/search
async function notion_search(args, ctx) {
  if (!args || !args.query) {
    return { ok: false, refused: true, reason: 'query_required' };
  }
  return apiCall.apiCall({
    service: 'notion',
    method:  'POST',
    path:    '/v1/search',
    body:    {
      query:        args.query,
      page_size:    args.page_size || 20,
      filter:       args.filter || undefined,
      sort:         args.sort   || undefined
    },
    credential_name: args.credential_name || 'NOTION_TOKEN',
    timeout_ms: args.timeout_ms
  }, ctx);
}

// Supabase: POST /rest/v1/rpc/{function_name} (PostgREST RPC).
// For raw SQL, operator should expose a `run_sql` SECURITY DEFINER
// function in their schema. Substrate refuses to send SQL to a non-RPC
// endpoint (Supabase REST doesn't accept raw SQL by design — caller MUST
// wrap SQL in an RPC).
async function supabase_run_sql(args, ctx) {
  if (!args || !args.base_url) {
    return { ok: false, refused: true, reason: 'base_url_required',
             detail: 'supabase requires base_url (https://<project-ref>.supabase.co)' };
  }
  if (!args.rpc_function || typeof args.rpc_function !== 'string') {
    return { ok: false, refused: true, reason: 'rpc_function_required',
             detail: 'Supabase REST does not accept raw SQL — wrap your SQL in a SECURITY DEFINER function and pass rpc_function=<name>. Pass parameters as args.params.' };
  }
  return apiCall.apiCall({
    service: 'supabase',
    base_url: args.base_url,
    method:  'POST',
    path:    '/rest/v1/rpc/' + encodeURIComponent(args.rpc_function),
    body:    args.params || {},
    credential_name: args.credential_name || 'SUPABASE_SERVICE_KEY',
    extra_headers: { 'Prefer': 'return=representation' },
    timeout_ms: args.timeout_ms
  }, ctx);
}

module.exports = {
  github_get_repo,
  github_create_issue,
  vercel_list_projects,
  notion_search,
  supabase_run_sql
};
