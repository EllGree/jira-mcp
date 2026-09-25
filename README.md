# jira-mcp

MCP server for Jira Cloud over the REST API v3, authenticated with an API token.

## Why it exists

Jira was reached through Atlassian's hosted MCP server. It works for most calls, but these gaps showed up in daily use:

- **Attachments cannot be read.** An issue comes back with attachment metadata and `blob:` placeholders in the description, and the image bytes never arrive. On OXXII-2845 the only way to see the two screenshots was to open the issue in a browser and zoom in, and opening `/rest/api/3/attachment/content/<id>` directly in the browser led to a URL that could not be captured. This server downloads an attachment to a local file and returns the path.
- **It runs on a service we do not control.** The claude.ai Atlassian connector hung for 300 seconds on the same calls and was disabled on 2026-08-03. Its OAuth tokens live on the hosting side, not on disk, so a local script cannot reuse them either. This server is a local process that talks to Jira directly.
- **Workarounds that each cost a failed call first:**
  - A mention written as `[~accountid:X]` in markdown arrives as literal text and notifies nobody; only an ADF mention node does. Here, both `[~accountid:X]` and `@[X]` in a text body become real mention nodes.
  - A worklog `started` with `+02:00` is rejected, and the error names a Java date pattern rather than the colon. Here `started` accepts `+02:00`, `Z` or no offset and is sent as `+0200`.
  - Workflow transition ids differ between issue types and between statuses, so an id cached from one issue fails on another. Here a transition is looked up on the issue at call time, by id, transition name or target status, and the status and assignee afterwards are reported, because post-functions do not fire the same way on every issue.
  - A written description or comment reads back correctly through the fields API while the page renders it broken, for example a list turned into headings. Writes here return the rendered HTML, and `jira_get_issue` has `format: "html"`.
  - Each hosted-MCP worklog call returned about 1.5 KB, so posting a hundred of them needed a separate script with its own token. Responses here are compact.

## Tools

| Tool | Does |
|---|---|
| `jira_whoami` | The account the token authenticates as |
| `jira_get_issue` | Issue with rendered description and comments, attachments, links, subtasks, changelog |
| `jira_search` | JQL search, paged with `next_page_token` |
| `jira_add_comment` | Comment from text (mentions, links, code, bullets) or raw ADF |
| `jira_edit_issue` | Edit fields; returns the fields as they read afterwards |
| `jira_get_transitions` | Transitions from the current status |
| `jira_transition` | Transition by id, name or target status |
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

Covers the text-to-ADF conversion (mentions above all), the worklog time format and the image ids in rendered HTML.

## Backlog

Not in v1: creating issues, uploading attachments, editing or deleting comments and worklogs, listing worklogs, remote links, boards and sprints, and headings or tables in the text body form (pass raw ADF for those).
