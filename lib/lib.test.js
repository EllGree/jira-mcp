import { test } from "node:test";
import assert from "node:assert/strict";

import { mentionIds, textToAdf } from "./adf.js";
import { jiraStarted } from "./time.js";
import { htmlToText } from "./html.js";
import { edgesFromWorkflows, statusPath } from "./path.js";

test("a wiki-style mention becomes a mention node, not literal text", () => {
  const doc = textToAdf("[~accountid:712020:abc-1] please check", { "712020:abc-1": "Karel" });
  const [p] = doc.content;
  assert.deepEqual(p.content[0], { type: "mention", attrs: { id: "712020:abc-1", text: "@Karel" } });
  assert.equal(p.content[1].text, " please check");
  assert.ok(!JSON.stringify(doc).includes("accountid"));
});

test("mentionIds finds both mention forms once each", () => {
  assert.deepEqual(mentionIds("@[a1] and [~accountid:b2] and @[a1]"), ["a1", "b2"]);
});

test("markdown link, bare url, code, bullets and paragraphs", () => {
  const doc = textToAdf("MR: [!42](https://gl.example/mr/42), see https://x.example/a.\n\n- one `x`\n- **two**");
  const [p, list] = doc.content;
  assert.equal(p.content[1].text, "!42");
  assert.deepEqual(p.content[1].marks, [{ type: "link", attrs: { href: "https://gl.example/mr/42" } }]);
  assert.equal(p.content[3].marks[0].attrs.href, "https://x.example/a");
  assert.equal(p.content[4].text, ".");
  assert.equal(list.type, "bulletList");
  assert.deepEqual(list.content[0].content[0].content[1], { type: "text", text: "x", marks: [{ type: "code" }] });
  assert.deepEqual(list.content[1].content[0].content[0].marks, [{ type: "strong" }]);
});

test("single newline is a hard break", () => {
  const [p] = textToAdf("a\nb").content;
  assert.deepEqual(p.content.map((n) => n.type), ["text", "hardBreak", "text"]);
});

test("worklog started drops the colon from the offset", () => {
  assert.equal(jiraStarted("2026-05-19T13:00:00+02:00"), "2026-05-19T13:00:00.000+0200");
  assert.equal(jiraStarted("2026-05-19T13:00:00.5Z"), "2026-05-19T13:00:00.500+0000");
  assert.equal(jiraStarted("2026-05-19T13:00:00.000+0200"), "2026-05-19T13:00:00.000+0200");
  assert.match(jiraStarted("2026-05-19T13:00"), /^2026-05-19T13:00:00\.000[+-]\d{4}$/);
  assert.throws(() => jiraStarted("yesterday"));
});

test("rendered images keep their attachment id", () => {
  const html =
    '<p>See <a href="https://x.example">https://x.example</a><br/><span class="image-wrap"><img src="/rest/api/3/attachment/content/226376" alt="shot.png"></span></p><ul><li>a &amp; b</li></ul>';
  assert.equal(htmlToText(html), "See https://x.example\n[image: attachment 226376]\n\n- a & b");
});

test("@[id|Name] carries its own name and needs no lookup", () => {
  assert.deepEqual(mentionIds("@[a1|Karel Petrák] and @[b2]"), ["b2"]);
  const [p] = textToAdf("@[a1|Karel Petrák] ping", {}).content;
  assert.deepEqual(p.content[0], { type: "mention", attrs: { id: "a1", text: "@Karel Petrák" } });
});

test("text without markers stays one plain text node", () => {
  const [p] = textToAdf("Just a note, nothing more.").content;
  assert.deepEqual(p.content, [{ type: "text", text: "Just a note, nothing more." }]);
});

const workflow = {
  statuses: [
    { statusReference: "s1", name: "Ready" },
    { statusReference: "s2", name: "In Progress" },
    { statusReference: "s3", name: "Code review" },
    { statusReference: "s4", name: "Merged" },
    { statusReference: "s5", name: "Ready for testing" },
    { statusReference: "s6", name: "Rejected" },
  ],
  workflows: [
    {
      transitions: [
        { name: "Create", type: "INITIAL", toStatusReference: "s1", links: [] },
        { name: "Start", toStatusReference: "s2", links: [{ fromStatusReference: "s1" }] },
        { name: "Review", toStatusReference: "s3", links: [{ fromStatusReference: "s2" }] },
        { name: "Merged", toStatusReference: "s4", links: [{ fromStatusReference: "s3" }] },
        { name: "RFT", to: { statusReference: "s5" }, from: [{ statusReference: "s4" }] },
        { name: "Reject", type: "GLOBAL", toStatusReference: "s6" },
      ],
    },
  ],
};

test("workflow edges read both transition shapes and globals", () => {
  const edges = edgesFromWorkflows(workflow);
  assert.ok(edges.some((e) => e.from === "Merged" && e.to === "Ready for testing"));
  assert.ok(edges.some((e) => e.from === null && e.to === "Rejected"));
  assert.ok(!edges.some((e) => e.name === "Create"));
});

test("Code review reaches Ready for testing only through Merged", () => {
  const edges = edgesFromWorkflows(workflow);
  assert.deepEqual(statusPath(edges, "Code review", "ready for testing"), ["Merged", "Ready for testing"]);
  assert.deepEqual(statusPath(edges, "Merged", "Merged"), []);
  assert.deepEqual(statusPath(edges, "Code review", "Rejected"), ["Rejected"]);
  assert.equal(statusPath(edges, "Ready for testing", "Ready"), null);
});
