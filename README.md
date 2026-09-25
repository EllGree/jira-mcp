# jira-mcp

MCP server for Jira Cloud over the REST API v3, authenticated with an API token.

## Why it exists

Jira was reached through Atlassian's hosted MCP server. It works for most calls, but these gaps showed up in daily use:

- **Attachments cannot be read.** An issue comes back with attachment metadata and `blob:` placeholders in the description, and the image bytes never arrive. On OXXII-2845 the only way to see the two screenshots was to open the issue in a browser and zoom in, and opening `/rest/api/3/attachment/content/<id>` directly in the browser led to a URL that could not be captured. This server downloads an attachment to a local file and returns the path.
- **It runs on a service we do not control.** The claude.ai Atlassian connector hung for 300 seconds on the same calls and was disabled on 2026-08-03. Its OAuth tokens live on the hosting side, not on disk, so a local script cannot reuse them either. This server is a local process that talks to Jira directly.
- **Mentions do not notify.** With `contentFormat: "markdown"`, `[~accountid:X]` is escaped to literal text and the person gets no notification; only an ADF mention node works. On OXXII-2529 none of the mentions in a markdown description reached Karel, and a separate ADF comment was needed to ping him. Here a text body takes `@[accountId]`, `@[accountId|Display Name]` or `[~accountid:X]` and sends a real mention node, looking the display name up when it is not given; text without a marker stays plain text. `dry_run` returns the generated ADF without posting. (memory: `reference_jira_mention_needs_adf.md`)
- **Transition ids drift, and some statuses are two steps away.** The same logical step has different ids on different issue types and from different statuses, so an id taken from one issue fails on another. From Code review the only way forward is Merged; Ready for testing is reached only through it, and the assignee is cleared on that second step, not the first. `jira_transition_to_status` takes a target status, plans the path, looks each step's transition up on the issue when it gets there (nothing is cached), and returns the final status and assignee; with no path it fails with the transitions that are available. `dry_run` shows the path. `jira_transition` stays as the low-level one-step call. (memory: `reference_jira_oxxii_transitions.md`, `feedback_rft_leaves_assignee_empty.md`)
- **Responses overflow the context.** An issue with a long comment thread came back too large to read and was saved to a dump file, and pasting the one comment by hand beat writing a parser for it (OXXII-2498). A single read of OXXII-2845 carried four avatar sizes for every user. Output here is compact by default: people as name and account id, the last N comments as author, date and text, the changelog as `date · who · field: from → to` lines, attachments as id, filename, size and type. Jira's full JSON only with `raw: true`. (memory: `feedback_ask_user_before_parsing_script.md`)
- **Smaller workarounds, each of which cost a failed call first:**
  - A worklog `started` with `+02:00` is rejected, and the error names a Java date pattern rather than the colon. Here `started` accepts `+02:00`, `Z` or no offset and is sent as `+0200`. (memory: `reference_jira_worklog_tz_format.md`)
  - A written description or comment reads back correctly through the fields API while the page renders it broken, for example a numbered list turned into headings on OXXII-2835. Writes here return the rendered HTML, and `jira_get_issue` has `format: "html"`. (memory: `feedback_check_rendered_jira_after_write.md`)
  - Each hosted-MCP worklog call returned about 1.5 KB, so posting a hundred of them needed a separate script with its own token. (memory: `reference_bulk_worklog_poster.md`)

## Tools

| Tool | Does |
|---|---|
| `jira_whoami` | The account the token authenticates as |
| `jira_get_issue` | Compact issue: rendered description, last N comments, changelog lines, attachments, links, subtasks |
| `jira_search` | JQL search, paged with `next_page_token` |
| `jira_add_comment` | Comment from text (mentions, links, code, bullets) or raw ADF; `dry_run` |
| `jira_edit_issue` | Edit fields; returns the fields as they read afterwards; `dry_run` |
| `jira_get_transitions` | Transitions from the current status |
| `jira_transition_to_status` | Walk to a target status through intermediate steps; `dry_run` shows the path |
| `jira_transition` | Low level: one transition by id or name; `dry_run` |
| `jira_add_worklog` | Log work; watchers not notified unless asked |
| `jira_link_types`, `jira_link_issues` | Issue links; the new link is read back as the issue shows it |
| `jira_lookup_user` | Users by name or email fragment, or by account id |
| `jira_download_attachment` | Save attachments to local files and return the paths; images optionally inline too |

In `jira_get_issue` output an inline image appears as `[image: attachment <id>]`, the id to pass to `jira_download_attachment`.

With `readOnly` set, the tools that write (comment, edit, transition, worklog, link) are not offered.

## Install

Needs Node 18 or newer.

```
npm install
```

Register the server with your MCP client as stdio: command `node`, argument the full path to `index.js`.

## Config

`config.json` next to `index.js` (gitignored; start from `config.example.json`), or the matching environment variables. A value left at an example placeholder counts as absent.

| Key | Environment | Meaning |
|---|---|---|
| `site` | `JIRA_MCP_SITE` | `https://<your-site>.atlassian.net`. Required. |
| `email` | `JIRA_MCP_EMAIL` | Email of the Atlassian account the token belongs to. Required. |
| `token` | `JIRA_MCP_TOKEN` | API token from https://id.atlassian.com/manage-profile/security/api-tokens. Required. |
| `cloudId` | `JIRA_MCP_CLOUD_ID` | Leave empty for a classic token. A scoped token only works through the `api.atlassian.com` gateway, and setting the cloud id switches to it. |
| `readOnly` | `JIRA_MCP_READONLY` | Withholds every writing tool. |
| `downloadDir` | `JIRA_MCP_DOWNLOAD_DIR` | Where attachments are saved. Defaults to `%LOCALAPPDATA%\jira-mcp\attachments`. |

The token acts as your account, with all of its permissions. Keep it out of the repository.

## Tests

```
npm test
```

Covers the text-to-ADF conversion (mentions above all), the path planning between statuses, the worklog time format and the image ids in rendered HTML.

## Path planning

The path comes from the issue's workflow (`POST /rest/api/3/workflows` for its project and issue type). Many sites allow that read to administrators only; without it the tool still takes a direct transition, or follows the statuses given in `via`, and otherwise fails with the transitions available from the current status. If a post-function moves the issue somewhere other than the expected next status, the rest of the path is planned again from where it landed.

## Backlog

Not in v1: creating issues, uploading attachments, editing or deleting comments and worklogs, listing worklogs, remote links, boards and sprints, and headings or tables in the text body form (pass raw ADF for those).
