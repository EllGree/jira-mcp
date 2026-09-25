import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A value copied out of config.example.json and never filled in is not a value. Without this the
 * placeholder wins over the environment, because `config.x || process.env.X` sees a truthy string,
 * and the failure arrives later as a 401 that says nothing about why.
 */
export function real(value) {
  if (typeof value !== "string") return "";
  const v = value.trim();
  if (!v) return "";
  if (/<[^>]*>/.test(v)) return "";
  return v;
}

let file = {};
try {
  file = JSON.parse(readFileSync(join(here, "..", "config.json"), "utf-8").replace(/^﻿/, ""));
} catch {
  file = {};
}

function setting(key, envName, fallback = "") {
  return real(file[key]) || real(process.env[envName]) || fallback;
}

/** The browser address of the Jira site. Issue links in the output are built from it. */
export const SITE = setting("site", "JIRA_MCP_SITE").replace(/\/+$/, "");
export const EMAIL = setting("email", "JIRA_MCP_EMAIL");
export const TOKEN = setting("token", "JIRA_MCP_TOKEN");

/**
 * A scoped API token only works through the api.atlassian.com gateway, which addresses the site by
 * its cloud id. A classic token works against the site directly. Setting the cloud id picks the
 * gateway; leaving it empty uses the site.
 */
export const CLOUD_ID = setting("cloudId", "JIRA_MCP_CLOUD_ID");

export const API_BASE = CLOUD_ID ? `https://api.atlassian.com/ex/jira/${CLOUD_ID}` : SITE;

export const READ_ONLY = file.readOnly === true || /^(1|true|yes)$/i.test(process.env.JIRA_MCP_READONLY || "");

export const DOWNLOAD_DIR = resolve(
  setting("downloadDir", "JIRA_MCP_DOWNLOAD_DIR") ||
    join(process.env.LOCALAPPDATA ?? join(process.env.HOME ?? ".", "AppData", "Local"), "jira-mcp", "attachments")
);

export function missingSettings() {
  const missing = [];
  if (!SITE) missing.push("`site` (JIRA_MCP_SITE)");
  if (!EMAIL) missing.push("`email` (JIRA_MCP_EMAIL)");
  if (!TOKEN) missing.push("`token` (JIRA_MCP_TOKEN)");
  return missing;
}
