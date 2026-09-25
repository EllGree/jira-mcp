// HTTP for the Jira Cloud REST API v3, with basic auth from an API token.

import { API_BASE, EMAIL, TOKEN, missingSettings } from "./config.js";

function authHeader() {
  const missing = missingSettings();
  if (missing.length) {
    throw new Error(`jira-mcp is not configured: set ${missing.join(", ")} in config.json or the environment`);
  }
  return "Basic " + Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");
}

function url(path, query) {
  const u = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === "") continue;
    u.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  return u;
}

/** Jira spreads the reason for a failure across `errorMessages` and a per-field `errors` map. */
function describeFailure(status, text) {
  let detail = text.slice(0, 500);
  try {
    const body = JSON.parse(text);
    const parts = [...(body.errorMessages || [])];
    for (const [field, msg] of Object.entries(body.errors || {})) parts.push(`${field}: ${msg}`);
    if (parts.length) detail = parts.join("; ");
  } catch {
    // not JSON, keep the text
  }
  const hint =
    status === 401
      ? " (the email and token do not authenticate; a scoped token also needs `cloudId` set)"
      : status === 404
        ? " (missing, or not visible to this account)"
        : "";
  return `Jira ${status}: ${detail}${hint}`;
}

export async function jira(method, path, { query, body } = {}) {
  const res = await fetch(url(path, query), {
    method,
    headers: {
      Authorization: authHeader(),
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(describeFailure(res.status, text));
  return text ? JSON.parse(text) : null;
}

export const get = (path, query) => jira("GET", path, { query });
export const post = (path, body, query) => jira("POST", path, { body, query });
export const put = (path, body, query) => jira("PUT", path, { body, query });

/**
 * The attachment content endpoint answers with a redirect to Atlassian's media store. fetch follows
 * it and, being cross-origin, drops the Authorization header on the way, which is what the media
 * store expects: the redirect URL carries its own short-lived token.
 */
export async function getBinary(path) {
  const res = await fetch(url(path), { headers: { Authorization: authHeader(), Accept: "*/*" } });
  if (!res.ok) throw new Error(describeFailure(res.status, await res.text()));
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") || "application/octet-stream",
  };
}
