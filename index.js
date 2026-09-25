#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { get, getBinary, post, put } from "./lib/jira.js";
import { mentionIds, textToAdf } from "./lib/adf.js";
import { htmlToText } from "./lib/html.js";
import { jiraStarted } from "./lib/time.js";
import { edgesFromWorkflows, statusPath } from "./lib/path.js";
import { DOWNLOAD_DIR, READ_ONLY, SITE, missingSettings } from "./lib/config.js";

const enc = encodeURIComponent;
const browseUrl = (key) => `${SITE}/browse/${key}`;

// Past this an image is saved but not also returned inline: a large base64 blob costs the caller
// its context, and the saved file can still be opened.
const MAX_INLINE_BYTES = 4 * 1024 * 1024;

const person = (u) => (u ? { name: u.displayName, account_id: u.accountId } : null);

/** Rendered HTML as text, or as-is when the caller wants to check the markup itself. */
const rendered = (html, format) => (format === "html" ? html || "" : htmlToText(html));

// ---- body text with mentions ----

async function adfFrom({ text, adf }) {
  if (adf) return typeof adf === "string" ? JSON.parse(adf) : adf;
  if (!text) throw new Error("provide text or adf");
  const names = {};
  for (const id of mentionIds(text)) {
    try {
      names[id] = (await get("/rest/api/3/user", { accountId: id })).displayName;
    } catch {
      // an unknown id still becomes a mention node; Jira decides whether it resolves
    }
  }
  return textToAdf(text, names);
}

// ---- issues ----

function summariseLink(l) {
  const other = l.outwardIssue || l.inwardIssue;
  return {
    id: l.id,
    relation: l.outwardIssue ? l.type.outward : l.type.inward,
    type: l.type.name,
    key: other?.key,
    summary: other?.fields?.summary,
    status: other?.fields?.status?.name,
  };
}

// Dates in the compact output are trimmed to the minute; the offset stays, since people and the
// server sit in different zones.
const shortDate = (iso) => (iso ? String(iso).replace(/:\d{2}\.\d{3}/, "") : iso);
const brief = (v) => (v === null || v === undefined || v === "" ? "∅" : String(v).replace(/\s+/g, " ").slice(0, 120));

/** One line per changed field: `date · who · field: from → to`, the newest `last` entries. */
function compactChangelog(changelog, last) {
  const lines = [];
  for (const h of changelog?.histories || []) {
    for (const i of h.items || []) {
      const from = i.fromString ?? i.from;
      const to = i.toString ?? i.to;
      // Two cut-off copies of a long text look identical and say nothing; the size change says more.
      const change =
        String(from ?? "").length > 120 || String(to ?? "").length > 120
          ? `edited (${String(from ?? "").length} → ${String(to ?? "").length} chars)`
          : `${brief(from)} → ${brief(to)}`;
      lines.push({ at: h.created, line: `${shortDate(h.created)} · ${h.author?.displayName ?? "?"} · ${i.field}: ${change}` });
    }
  }
  lines.sort((a, b) => (a.at < b.at ? -1 : 1));
  return { total: lines.length, lines: lines.slice(-last).map((l) => l.line) };
}

async function getIssue({ issue_key, format = "text", comments_last = 10, changelog = true, changelog_last = 20, extra_fields = [], raw = false }) {
  if (!issue_key) throw new Error("issue_key is required");
  const expand = ["renderedFields", ...(changelog ? ["changelog"] : [])];
  const issue = await get(`/rest/api/3/issue/${enc(issue_key)}`, { expand });
  if (raw) return issue;

  const f = issue.fields;
  const r = issue.renderedFields || {};
  const renderedComments = new Map((r.comment?.comments || []).map((c) => [c.id, c.body]));
  const allComments = f.comment?.comments || [];
  const shownComments = Number(comments_last) > 0 ? allComments.slice(-Number(comments_last)) : [];

  const out = {
    key: issue.key,
    url: browseUrl(issue.key),
    summary: f.summary,
    type: f.issuetype?.name,
    status: f.status?.name,
    priority: f.priority?.name,
    resolution: f.resolution?.name ?? null,
    assignee: person(f.assignee),
    reporter: person(f.reporter),
    labels: f.labels,
    parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary } : undefined,
    sprint: undefined,
    created: shortDate(f.created),
    updated: shortDate(f.updated),
    description: rendered(r.description, format),
    attachments: (f.attachment || []).map((a) => ({ id: a.id, filename: a.filename, size: a.size, mime_type: a.mimeType })),
    links: (f.issuelinks || []).map(summariseLink).map((l) => `${l.relation} ${l.key} [${l.status}] ${l.summary}`),
    subtasks: (f.subtasks || []).map((s) => `${s.key} [${s.fields?.status?.name}] ${s.fields?.summary}`),
    comments_total: f.comment?.total ?? allComments.length,
    comments: shownComments.map((c) => ({
      author: c.author?.displayName,
      date: shortDate(c.created),
      text: rendered(renderedComments.get(c.id), format),
    })),
  };
  // The sprint lives in a custom field whose id differs per site; find it by its shape.
  for (const v of Object.values(f)) {
    if (Array.isArray(v) && v[0] && typeof v[0] === "object" && "boardId" in v[0] && "state" in v[0]) {
      out.sprint = v.map((s) => ({ name: s.name, state: s.state }));
    }
  }
  for (const name of extra_fields) {
    out[name] = { value: f[name], rendered: r[name] !== undefined ? rendered(r[name], format) : undefined };
  }
  if (changelog) {
    const c = compactChangelog(issue.changelog, Number(changelog_last) > 0 ? Number(changelog_last) : Infinity);
    out.changelog_total = c.total;
    out.changelog = c.lines;
  }
  return out;
}

const DEFAULT_SEARCH_FIELDS = ["summary", "status", "assignee", "issuetype", "priority", "updated"];

async function search({ jql, fields = [], max_results = 50, next_page_token }) {
  if (!jql) throw new Error("jql is required");
  const wanted = [...new Set([...DEFAULT_SEARCH_FIELDS, ...fields])];
  const r = await post("/rest/api/3/search/jql", {
    jql,
    fields: wanted,
    maxResults: Math.min(Number(max_results) || 50, 100),
    ...(next_page_token ? { nextPageToken: next_page_token } : {}),
  });
  return {
    count: (r.issues || []).length,
    next_page_token: r.nextPageToken ?? null,
    issues: (r.issues || []).map((i) => {
      const f = i.fields;
      const row = {
        key: i.key,
        summary: f.summary,
        type: f.issuetype?.name,
        status: f.status?.name,
        priority: f.priority?.name,
        assignee: f.assignee?.displayName ?? null,
        updated: f.updated,
      };
      for (const name of fields) if (!DEFAULT_SEARCH_FIELDS.includes(name)) row[name] = f[name];
      return row;
    }),
  };
}

// ---- comments ----

async function addComment({ issue_key, text, adf, dry_run = false }) {
  if (!issue_key) throw new Error("issue_key is required");
  const body = await adfFrom({ text, adf });
  if (dry_run) return { dry_run: true, issue_key, adf: body };
  const c = await post(`/rest/api/3/issue/${enc(issue_key)}/comment`, { body });
  // What the API accepted and what the page shows can differ; hand back the rendered form to check.
  const back = await get(`/rest/api/3/issue/${enc(issue_key)}/comment/${c.id}`, { expand: "renderedBody" });
  return { id: c.id, url: `${browseUrl(issue_key)}?focusedCommentId=${c.id}`, rendered_html: back.renderedBody };
}

// ---- edits ----

async function editIssue({ issue_key, fields = {}, update, description_text, notify_users = true, dry_run = false }) {
  if (!issue_key) throw new Error("issue_key is required");
  const payload = { fields: { ...fields } };
  if (description_text !== undefined) payload.fields.description = await adfFrom({ text: description_text });
  if (update) payload.update = update;
  if (!Object.keys(payload.fields).length && !update) throw new Error("nothing to change: give fields, update or description_text");
  if (dry_run) return { dry_run: true, issue_key, payload };
  await put(`/rest/api/3/issue/${enc(issue_key)}`, payload, { notifyUsers: notify_users ? undefined : "false" });

  const touched = [...new Set([...Object.keys(payload.fields), ...Object.keys(update || {})])];
  const back = await get(`/rest/api/3/issue/${enc(issue_key)}`, { fields: touched, expand: "renderedFields" });
  const now = {};
  for (const k of touched) {
    now[k] = back.renderedFields?.[k] ?? back.fields?.[k];
  }
  return { updated: issue_key, now };
}

// ---- transitions ----
//
// Transition ids differ between issue types and between statuses, so an id is only ever taken from
// this issue's own transition list, fetched at the moment of use. Nothing is cached.

async function listTransitions(issue_key) {
  const r = await get(`/rest/api/3/issue/${enc(issue_key)}/transitions`);
  return (r.transitions || []).map((t) => ({ id: t.id, name: t.name, to: t.to?.name }));
}

const listing = (available) => available.map((t) => `${t.id} ${t.name} -> ${t.to}`).join("; ") || "none";

async function statusAndAssignee(issue_key) {
  const r = await get(`/rest/api/3/issue/${enc(issue_key)}`, { fields: "status,assignee,project,issuetype" });
  return {
    status: r.fields.status?.name,
    assignee: r.fields.assignee?.displayName ?? null,
    projectId: r.fields.project?.id,
    issueTypeId: r.fields.issuetype?.id,
  };
}

async function getTransitions({ issue_key }) {
  if (!issue_key) throw new Error("issue_key is required");
  return { issue_key, transitions: await listTransitions(issue_key) };
}

/** Low level: one transition, by id or by transition name, from the current status. */
async function transition({ issue_key, transition: wanted, fields, comment_text, dry_run = false }) {
  if (!issue_key) throw new Error("issue_key is required");
  if (!wanted) throw new Error("transition is required: an id or a transition name");
  const available = await listTransitions(issue_key);
  const w = String(wanted).trim();
  let hits = available.filter((t) => t.id === w);
  if (!hits.length) hits = available.filter((t) => t.name.toLowerCase() === w.toLowerCase());
  if (!hits.length) throw new Error(`No transition "${wanted}" from the current status. Available: ${listing(available)}`);
  if (hits.length > 1) throw new Error(`"${wanted}" matches several transitions: ${hits.map((t) => `${t.id} ${t.name}`).join("; ")}`);

  const body = { transition: { id: hits[0].id } };
  if (fields) body.fields = fields;
  if (comment_text) body.update = { comment: [{ add: { body: await adfFrom({ text: comment_text }) } }] };
  const before = await statusAndAssignee(issue_key);
  if (dry_run) return { dry_run: true, issue_key, status_now: before.status, would_use: hits[0], body };
  await post(`/rest/api/3/issue/${enc(issue_key)}/transitions`, body);

  // Post-functions can move the issue further or change the assignee, so report what is true now.
  const after = await statusAndAssignee(issue_key);
  return { issue_key, used: hits[0], status_before: before.status, status_now: after.status, assignee_now: after.assignee };
}

/**
 * The workflow as status-name edges, when this account may read it (the bulk workflow read needs
 * admin rights on many sites). Returns { edges } or { reason } when it cannot.
 */
async function workflowEdges(projectId, issueTypeId) {
  try {
    const r = await post("/rest/api/3/workflows", { projectAndIssueTypes: [{ projectId, issueTypeId }] });
    const edges = edgesFromWorkflows(r);
    return edges?.length ? { edges } : { reason: "the workflow read returned no transitions" };
  } catch (err) {
    return { reason: `the workflow could not be read (${err.message})` };
  }
}

/** The statuses to pass through, ending with the target, or a reason there is none. */
async function planPath(issue_key, now, target, via) {
  if (now.status.toLowerCase() === target.toLowerCase()) return { path: [], planned_by: "already there" };
  const available = await listTransitions(issue_key);
  if (available.some((t) => (t.to || "").toLowerCase() === target.toLowerCase())) {
    return { path: [target], planned_by: "direct transition", available };
  }
  if (via?.length) return { path: [...via, target], planned_by: "via, as given", available };
  const wf = await workflowEdges(now.projectId, now.issueTypeId);
  if (wf.edges) {
    const path = statusPath(wf.edges, now.status, target);
    if (path) return { path, planned_by: "workflow", available };
    return { error: `The workflow has no path from ${now.status} to ${target}.`, available };
  }
  return {
    error: `No direct transition from ${now.status} to ${target}, and ${wf.reason}. Pass \`via\` with the statuses in between.`,
    available,
  };
}

const MAX_STEPS = 8;

async function transitionToStatus({ issue_key, status: target, via, comment_text, dry_run = false }) {
  if (!issue_key) throw new Error("issue_key is required");
  if (!target) throw new Error("status is required: the target status name");
  const start = await statusAndAssignee(issue_key);
  const plan = await planPath(issue_key, start, target, via);
  if (plan.error) throw new Error(`${plan.error} Available from ${start.status}: ${listing(plan.available)}`);

  if (dry_run) {
    const first = plan.path.length ? plan.available.filter((t) => (t.to || "").toLowerCase() === plan.path[0].toLowerCase()) : [];
    return {
      dry_run: true,
      issue_key,
      status_now: start.status,
      target,
      planned_by: plan.planned_by,
      path: [start.status, ...plan.path].join(" → "),
      first_step: first.map((t) => `${t.id} ${t.name}`),
      note: plan.path.length > 1 ? "Later steps are looked up on the issue when they are reached." : undefined,
    };
  }

  const steps = [];
  let now = start;
  let path = plan.path;
  let commented = false;
  while (now.status.toLowerCase() !== target.toLowerCase()) {
    if (steps.length >= MAX_STEPS) throw new Error(`Stopped after ${MAX_STEPS} steps at ${now.status}. Steps: ${JSON.stringify(steps)}`);
    const next = path[0];
    const available = await listTransitions(issue_key);
    const hits = available.filter((t) => (t.to || "").toLowerCase() === String(next).toLowerCase());
    if (hits.length !== 1) {
      throw new Error(
        `At ${now.status}: ${hits.length ? "several transitions" : "no transition"} to ${next}. Available: ${listing(available)}. Done so far: ${JSON.stringify(steps)}`
      );
    }
    const body = { transition: { id: hits[0].id } };
    if (path.length === 1 && comment_text && !commented) {
      body.update = { comment: [{ add: { body: await adfFrom({ text: comment_text }) } }] };
      commented = true;
    }
    await post(`/rest/api/3/issue/${enc(issue_key)}/transitions`, body);
    const after = await statusAndAssignee(issue_key);
    steps.push({ from: now.status, to: after.status, transition: `${hits[0].id} ${hits[0].name}` });
    // A post-function can carry the issue past the expected status; plan again from where it is.
    if (after.status.toLowerCase() === String(next).toLowerCase()) path = path.slice(1);
    else if (after.status.toLowerCase() !== target.toLowerCase()) {
      const again = await planPath(issue_key, after, target, null);
      if (again.error) throw new Error(`${again.error} Done so far: ${JSON.stringify(steps)}`);
      path = again.path;
    }
    now = after;
  }
  // A post-function that skipped the last step also skipped the comment riding on it.
  if (comment_text && !commented && steps.length) {
    await post(`/rest/api/3/issue/${enc(issue_key)}/comment`, { body: await adfFrom({ text: comment_text }) });
  }
  return { issue_key, status_before: start.status, status_now: now.status, assignee_now: now.assignee, steps };
}

// ---- worklog ----

async function addWorklog({ issue_key, time_spent, time_spent_seconds, started, comment_text, notify_users = false, adjust_estimate }) {
  if (!issue_key) throw new Error("issue_key is required");
  if (!time_spent && !time_spent_seconds) throw new Error("give time_spent (e.g. \"1h 30m\") or time_spent_seconds");
  const body = {};
  if (time_spent) body.timeSpent = time_spent;
  else body.timeSpentSeconds = Number(time_spent_seconds);
  if (started) body.started = jiraStarted(started);
  if (comment_text) body.comment = await adfFrom({ text: comment_text });
  const w = await post(`/rest/api/3/issue/${enc(issue_key)}/worklog`, body, {
    notifyUsers: notify_users ? "true" : "false",
    adjustEstimate: adjust_estimate,
  });
  return { id: w.id, issue_key, time_spent: w.timeSpent, started: w.started, author: w.author?.displayName };
}

// ---- links ----

async function linkTypes() {
  const r = await get("/rest/api/3/issueLinkType");
  return (r.issueLinkTypes || []).map((t) => ({ id: t.id, name: t.name, inward: t.inward, outward: t.outward }));
}

async function linkIssues({ type, inward_issue, outward_issue, comment_text }) {
  if (!type || !inward_issue || !outward_issue) throw new Error("type, inward_issue and outward_issue are required");
  const body = { type: { name: type }, inwardIssue: { key: inward_issue }, outwardIssue: { key: outward_issue } };
  if (comment_text) body.comment = { body: await adfFrom({ text: comment_text }) };
  await post("/rest/api/3/issueLink", body);
  // Which side reads "blocks" and which "is blocked by" is easy to get backwards, so read it back
  // the way the issue page shows it.
  const back = await get(`/rest/api/3/issue/${enc(inward_issue)}`, { fields: "issuelinks" });
  const shown = (back.fields.issuelinks || [])
    .map(summariseLink)
    .filter((l) => l.key === outward_issue && l.type.toLowerCase() === type.toLowerCase())
    .map((l) => `${inward_issue} ${l.relation} ${outward_issue}`);
  return { linked: true, as_shown_on_issue: shown };
}

// ---- users ----

async function lookupUser({ query, account_id }) {
  if (account_id) {
    const u = await get("/rest/api/3/user", { accountId: account_id });
    return [{ account_id: u.accountId, name: u.displayName, email: u.emailAddress, active: u.active }];
  }
  if (!query) throw new Error("give query or account_id");
  const r = await get("/rest/api/3/user/search", { query, maxResults: 20 });
  return r.map((u) => ({ account_id: u.accountId, name: u.displayName, email: u.emailAddress, active: u.active }));
}

// ---- attachments ----

const safeName = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 150);

async function saveAttachment(id, dir) {
  const meta = await get(`/rest/api/3/attachment/${enc(id)}`);
  const { buffer, contentType } = await getBinary(`/rest/api/3/attachment/content/${enc(id)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}-${safeName(meta.filename)}`);
  writeFileSync(path, buffer);
  return { id: String(id), filename: meta.filename, mime_type: meta.mimeType || contentType, size: buffer.length, path, buffer };
}

async function downloadAttachment({ attachment_id, issue_key, filename, dir, inline = false }) {
  const target = dir || DOWNLOAD_DIR;
  let ids;
  if (attachment_id) ids = [attachment_id];
  else if (issue_key) {
    const issue = await get(`/rest/api/3/issue/${enc(issue_key)}`, { fields: "attachment" });
    const all = issue.fields.attachment || [];
    const picked = filename ? all.filter((a) => a.filename === filename) : all;
    if (!picked.length) {
      throw new Error(`No ${filename ? `"${filename}"` : "attachments"} on ${issue_key}. There: ${all.map((a) => `${a.id} ${a.filename}`).join(", ") || "none"}`);
    }
    ids = picked.map((a) => a.id);
  } else throw new Error("give attachment_id, or issue_key (optionally with filename)");

  const saved = [];
  for (const id of ids) saved.push(await saveAttachment(id, target));

  const content = [
    { type: "text", text: JSON.stringify(saved.map(({ buffer, ...rest }) => rest), null, 2) },
  ];
  if (inline) {
    for (const s of saved) {
      if (s.mime_type.startsWith("image/") && s.size <= MAX_INLINE_BYTES) {
        content.push({ type: "image", data: s.buffer.toString("base64"), mimeType: s.mime_type });
      }
    }
  }
  return { content };
}

// ---- tools ----

const key = { type: "string", description: "Issue key, e.g. PROJ-123" };
const textBody =
  "Text with light markdown. @[accountId], @[accountId|Display Name] or [~accountid:ID] becomes a real mention that notifies (the name is looked up when not given); [label](url), bare URLs, `code` and **bold** are kept; a blank line starts a paragraph; a block of '- ' lines is a bullet list. Text without these markers stays plain text.";
const dryRun = { type: "boolean", description: "Build and return the request (the generated ADF) without sending it" };

// Each tool carries its own handler, so a tool cannot be listed without being dispatched or the reverse.
const TOOLS = [
  {
    name: "jira_whoami",
    description: "The account the configured token authenticates as. A quick check that the config works.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const u = await get("/rest/api/3/myself");
      return { account_id: u.accountId, name: u.displayName, email: u.emailAddress, time_zone: u.timeZone };
    },
  },
  {
    name: "jira_get_issue",
    description:
      "Get an issue, compact: people as name and account id, the last comments as author, date and text, the changelog as 'date · who · field: from → to' lines, attachments as id, filename, size and type. Inline images show as [image: attachment <id>]; fetch them with jira_download_attachment.",
    inputSchema: {
      type: "object",
      properties: {
        issue_key: key,
        format: { type: "string", enum: ["text", "html"], description: "text (default), or the rendered HTML to check how markup came out" },
        comments_last: { type: "number", description: "How many of the newest comments to include (default 10, 0 for none); comments_total says how many exist" },
        changelog: { type: "boolean", description: "Include the change history (default true)" },
        changelog_last: { type: "number", description: "How many of the newest change lines to include (default 20, 0 for all)" },
        extra_fields: { type: "array", items: { type: "string" }, description: "Further field ids to include, e.g. customfield_10016" },
        raw: { type: "boolean", description: "Return Jira's full JSON instead of the compact form. Large." },
      },
      required: ["issue_key"],
    },
    handler: getIssue,
  },
  {
    name: "jira_search",
    description: "Search issues by JQL. Pages with next_page_token.",
    inputSchema: {
      type: "object",
      properties: {
        jql: { type: "string" },
        fields: { type: "array", items: { type: "string" }, description: "Extra fields to return beyond summary, status, assignee, type, priority, updated" },
        max_results: { type: "number", description: "Up to 100, default 50" },
        next_page_token: { type: "string" },
      },
      required: ["jql"],
    },
    handler: search,
  },
  {
    name: "jira_add_comment",
    write: true,
    description: "Add a comment. Returns the comment's rendered HTML so the result can be checked.",
    inputSchema: {
      type: "object",
      properties: {
        issue_key: key,
        text: { type: "string", description: textBody },
        adf: { type: "object", description: "A full ADF document, instead of text" },
        dry_run: dryRun,
      },
      required: ["issue_key"],
    },
    handler: addComment,
  },
  {
    name: "jira_edit_issue",
    write: true,
    description: "Edit issue fields. Returns the edited fields as they read afterwards (rendered where Jira renders them).",
    inputSchema: {
      type: "object",
      properties: {
        issue_key: key,
        fields: { type: "object", description: 'Jira "fields" object, e.g. {"summary": "...", "assignee": {"accountId": "..."}}' },
        update: { type: "object", description: 'Jira "update" object, e.g. {"labels": [{"add": "x"}]}' },
        description_text: { type: "string", description: "New description as text. " + textBody },
        notify_users: { type: "boolean", description: "Default true" },
        dry_run: dryRun,
      },
      required: ["issue_key"],
    },
    handler: editIssue,
  },
  {
    name: "jira_get_transitions",
    description: "The transitions available on this issue from its current status.",
    inputSchema: { type: "object", properties: { issue_key: key }, required: ["issue_key"] },
    handler: getTransitions,
  },
  {
    name: "jira_transition",
    write: true,
    description:
      "Low level: one transition from the current status, by id or transition name, checked against this issue's own list at call time. To reach a status, use jira_transition_to_status. Returns the status and assignee afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        issue_key: key,
        transition: { type: "string", description: "Transition id or transition name" },
        fields: { type: "object", description: "Fields the transition screen requires" },
        comment_text: { type: "string", description: "Optional comment added with the transition. " + textBody },
        dry_run: dryRun,
      },
      required: ["issue_key", "transition"],
    },
    handler: transition,
  },
  {
    name: "jira_transition_to_status",
    write: true,
    description:
      "Move an issue to a target status, walking through intermediate statuses when there is no direct transition (e.g. Code review → Merged → Ready for testing). Each step's transition is looked up on the issue when reached; ids are never cached. The path comes from the workflow when this account can read it, otherwise from `via`. Fails with the available transitions when there is no path. Returns the final status and assignee (a post-function may clear it).",
    inputSchema: {
      type: "object",
      properties: {
        issue_key: key,
        status: { type: "string", description: "Target status name, e.g. Ready for testing" },
        via: { type: "array", items: { type: "string" }, description: "Statuses to pass through, when the workflow cannot be read" },
        comment_text: { type: "string", description: "Optional comment added with the last step. " + textBody },
        dry_run: { type: "boolean", description: "Resolve and return the path without moving the issue" },
      },
      required: ["issue_key", "status"],
    },
    handler: transitionToStatus,
  },
  {
    name: "jira_add_worklog",
    write: true,
    description:
      "Log work. `started` accepts 2026-09-25T13:00, ...+02:00 or ...Z and is converted to the +0200 form Jira requires; with no offset, the machine's local offset is used. Watchers are not notified unless notify_users is true.",
    inputSchema: {
      type: "object",
      properties: {
        issue_key: key,
        time_spent: { type: "string", description: 'e.g. "1h 30m"' },
        time_spent_seconds: { type: "number" },
        started: { type: "string" },
        comment_text: { type: "string" },
        notify_users: { type: "boolean", description: "Default false" },
        adjust_estimate: { type: "string", enum: ["auto", "leave", "new", "manual"] },
      },
      required: ["issue_key"],
    },
    handler: addWorklog,
  },
  {
    name: "jira_link_types",
    description: "The issue link types on this site, with their inward and outward wording.",
    inputSchema: { type: "object", properties: {} },
    handler: linkTypes,
  },
  {
    name: "jira_link_issues",
    write: true,
    description: "Link two issues. Returns the link as the inward issue's page shows it, so the direction can be checked.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Link type name, e.g. Blocks, Relates, Duplicate" },
        inward_issue: { type: "string" },
        outward_issue: { type: "string" },
        comment_text: { type: "string" },
      },
      required: ["type", "inward_issue", "outward_issue"],
    },
    handler: linkIssues,
  },
  {
    name: "jira_lookup_user",
    description: "Find users by name or email fragment, or read one by account id. The account id is what a mention needs.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, account_id: { type: "string" } },
    },
    handler: lookupUser,
  },
  {
    name: "jira_download_attachment",
    description:
      "Download attachments to local files and return their paths, which an image viewer or the Read tool can open. By attachment_id, or every attachment of issue_key (optionally one filename). inline=true also returns images inline.",
    inputSchema: {
      type: "object",
      properties: {
        attachment_id: { type: "string" },
        issue_key: key,
        filename: { type: "string" },
        dir: { type: "string", description: `Target directory, default ${DOWNLOAD_DIR}` },
        inline: { type: "boolean" },
      },
    },
    handler: downloadAttachment,
  },
];

const available = TOOLS.filter((t) => !(READ_ONLY && t.write));

const missing = missingSettings();
console.error(
  `jira-mcp: ${available.length} tools${READ_ONLY ? " (read-only)" : ""}` +
    (missing.length ? `; not configured, missing ${missing.join(", ")}` : "")
);

const server = new Server({ name: "jira-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: available.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = available.find((t) => t.name === name);
  if (!tool) {
    const reason = TOOLS.some((t) => t.name === name) ? "the server is read-only" : "unknown tool";
    return { isError: true, content: [{ type: "text", text: `${name}: ${reason}` }] };
  }
  try {
    const result = await tool.handler(args || {});
    if (result && Array.isArray(result.content)) return result;
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const causes = [];
    for (let e = err.cause; e; e = e.cause) causes.push(e.code || e.message);
    const detail = causes.length ? ` (cause: ${causes.join(" <- ")})` : "";
    return { isError: true, content: [{ type: "text", text: `Error: ${err.message || String(err)}${detail}` }] };
  }
});

await server.connect(new StdioServerTransport());
