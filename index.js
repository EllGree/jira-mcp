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

function summariseChangelog(changelog) {
  return (changelog?.histories || []).map((h) => ({
    created: h.created,
    author: h.author?.displayName,
    items: (h.items || []).map((i) => ({ field: i.field, from: i.fromString ?? i.from, to: i.toString ?? i.to })),
  }));
}

async function getIssue({ issue_key, format = "text", changelog = true, extra_fields = [], raw = false }) {
  if (!issue_key) throw new Error("issue_key is required");
  const expand = ["renderedFields", ...(changelog ? ["changelog"] : [])];
  const issue = await get(`/rest/api/3/issue/${enc(issue_key)}`, { expand });
  if (raw) return issue;

  const f = issue.fields;
  const r = issue.renderedFields || {};
  const renderedComments = new Map((r.comment?.comments || []).map((c) => [c.id, c.body]));

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
    created: f.created,
    updated: f.updated,
    description: rendered(r.description, format),
    attachments: (f.attachment || []).map((a) => ({
      id: a.id,
      filename: a.filename,
      mime_type: a.mimeType,
      size: a.size,
      author: a.author?.displayName,
      created: a.created,
    })),
    links: (f.issuelinks || []).map(summariseLink),
    subtasks: (f.subtasks || []).map((s) => ({ key: s.key, summary: s.fields?.summary, status: s.fields?.status?.name })),
    comments: (f.comment?.comments || []).map((c) => ({
      id: c.id,
      author: c.author?.displayName,
      created: c.created,
      updated: c.updated !== c.created ? c.updated : undefined,
      body: rendered(renderedComments.get(c.id), format),
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
  if (changelog) out.changelog = summariseChangelog(issue.changelog);
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

async function addComment({ issue_key, text, adf }) {
  if (!issue_key) throw new Error("issue_key is required");
  const body = await adfFrom({ text, adf });
  const c = await post(`/rest/api/3/issue/${enc(issue_key)}/comment`, { body });
  // What the API accepted and what the page shows can differ; hand back the rendered form to check.
  const back = await get(`/rest/api/3/issue/${enc(issue_key)}/comment/${c.id}`, { expand: "renderedBody" });
  return { id: c.id, url: `${browseUrl(issue_key)}?focusedCommentId=${c.id}`, rendered_html: back.renderedBody };
}

// ---- edits ----

async function editIssue({ issue_key, fields = {}, update, description_text, notify_users = true }) {
  if (!issue_key) throw new Error("issue_key is required");
  const payload = { fields: { ...fields } };
  if (description_text !== undefined) payload.fields.description = await adfFrom({ text: description_text });
  if (update) payload.update = update;
  if (!Object.keys(payload.fields).length && !update) throw new Error("nothing to change: give fields, update or description_text");
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

async function listTransitions(issue_key) {
  const r = await get(`/rest/api/3/issue/${enc(issue_key)}/transitions`);
  return (r.transitions || []).map((t) => ({ id: t.id, name: t.name, to: t.to?.name }));
}

async function getTransitions({ issue_key }) {
  if (!issue_key) throw new Error("issue_key is required");
  return { issue_key, transitions: await listTransitions(issue_key) };
}

// Transition ids differ between issue types and between statuses, so the id is always looked up on
// this issue, now, whatever the caller passes: an id, a transition name, or the target status.
async function transition({ issue_key, transition: wanted, fields, comment_text }) {
  if (!issue_key) throw new Error("issue_key is required");
  if (!wanted) throw new Error("transition is required: an id, a transition name, or the target status");
  const available = await listTransitions(issue_key);
  const w = String(wanted).trim().toLowerCase();
  let hits = available.filter((t) => t.id === String(wanted).trim());
  if (!hits.length) hits = available.filter((t) => t.name.toLowerCase() === w);
  if (!hits.length) hits = available.filter((t) => (t.to || "").toLowerCase() === w);
  const listing = available.map((t) => `${t.id} ${t.name} -> ${t.to}`).join("; ");
  if (!hits.length) throw new Error(`No transition "${wanted}" from the current status. Available: ${listing || "none"}`);
  if (hits.length > 1) throw new Error(`"${wanted}" matches several transitions: ${hits.map((t) => `${t.id} ${t.name}`).join("; ")}`);

  const body = { transition: { id: hits[0].id } };
  if (fields) body.fields = fields;
  if (comment_text) body.update = { comment: [{ add: { body: await adfFrom({ text: comment_text }) } }] };
  const before = await get(`/rest/api/3/issue/${enc(issue_key)}`, { fields: "status" });
  await post(`/rest/api/3/issue/${enc(issue_key)}/transitions`, body);

  // Post-functions can move the issue further or change the assignee, so report what is true now.
  const after = await get(`/rest/api/3/issue/${enc(issue_key)}`, { fields: "status,assignee" });
  return {
    issue_key,
    used: hits[0],
    status_before: before.fields.status?.name,
    status_now: after.fields.status?.name,
    assignee_now: after.fields.assignee?.displayName ?? null,
  };
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

const key = { type: "string", description: "Issue key, e.g. OXXII-2845" };
const textBody =
  "Plain text. [~accountid:ID] or @[ID] becomes a real mention that notifies; [label](url), bare URLs, `code` and **bold** are kept; a blank line starts a paragraph; a block of '- ' lines is a bullet list.";

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
      "Get an issue with its rendered description and comments, attachments, links, subtasks and changelog. Inline images show as [image: attachment <id>]; fetch them with jira_download_attachment.",
    inputSchema: {
      type: "object",
      properties: {
        issue_key: key,
        format: { type: "string", enum: ["text", "html"], description: "text (default), or the rendered HTML to check how markup came out" },
        changelog: { type: "boolean", description: "Include the change history (default true)" },
        extra_fields: { type: "array", items: { type: "string" }, description: "Further field ids to include, e.g. customfield_10016" },
        raw: { type: "boolean", description: "Return Jira's full JSON instead of the summary" },
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
      "Move an issue through its workflow. The transition is looked up on this issue at call time, so pass an id, a transition name, or the target status name. Returns the status and assignee afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        issue_key: key,
        transition: { type: "string", description: "Transition id, transition name, or target status name" },
        fields: { type: "object", description: "Fields the transition screen requires" },
        comment_text: { type: "string", description: "Optional comment added with the transition. " + textBody },
      },
      required: ["issue_key", "transition"],
    },
    handler: transition,
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
