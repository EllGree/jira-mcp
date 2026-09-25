// Plain text to Atlassian Document Format.
//
// Jira v3 takes comment and description bodies as ADF only. A mention written as wiki markup,
// `[~accountid:X]`, arrives as literal text and notifies nobody; only an ADF mention node does.
// So the text form accepted here turns every mention token into a real mention node.
//
// Accepted inside the text:
//   [~accountid:ID]  or  @[ID]   a mention
//   [label](https://...)         a link
//   https://...                  a bare link
//   `code`                       inline code
//   **bold**                     strong
// A blank line starts a new paragraph, a single newline is a line break, and a block whose every
// line starts with "- " or "* " becomes a bullet list.

const ACCOUNT = "[\\w:-]+";
const INLINE = new RegExp(
  [
    `\\[~accountid:(${ACCOUNT})\\]`,
    `@\\[(${ACCOUNT})\\]`,
    "\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)",
    "(https?:\\/\\/[^\\s<>()]*[^\\s<>().,;:!?'\"])",
    "`([^`]+)`",
    "\\*\\*([^*]+)\\*\\*",
  ].join("|"),
  "g"
);

/** The account ids mentioned in `text`, so the caller can look their names up first. */
export function mentionIds(text) {
  const ids = new Set();
  for (const m of String(text).matchAll(INLINE)) {
    if (m[1] || m[2]) ids.add(m[1] || m[2]);
  }
  return [...ids];
}

function textNode(text, marks) {
  if (!text) return null;
  return marks ? { type: "text", text, marks } : { type: "text", text };
}

export function inline(line, names = {}) {
  const out = [];
  let last = 0;
  for (const m of line.matchAll(INLINE)) {
    out.push(textNode(line.slice(last, m.index)));
    const [, accA, accB, label, href, bare, code, bold] = m;
    const id = accA || accB;
    if (id) {
      const name = names[id];
      out.push({ type: "mention", attrs: { id, text: name ? `@${name}` : `@${id}` } });
    } else if (label) {
      out.push(textNode(label, [{ type: "link", attrs: { href } }]));
    } else if (bare) {
      out.push(textNode(bare, [{ type: "link", attrs: { href: bare } }]));
    } else if (code) {
      out.push(textNode(code, [{ type: "code" }]));
    } else if (bold) {
      out.push(textNode(bold, [{ type: "strong" }]));
    }
    last = m.index + m[0].length;
  }
  out.push(textNode(line.slice(last)));
  return out.filter(Boolean);
}

function paragraph(lines, names) {
  const content = [];
  lines.forEach((line, i) => {
    if (i > 0) content.push({ type: "hardBreak" });
    content.push(...inline(line, names));
  });
  return { type: "paragraph", content };
}

const BULLET = /^\s*[-*]\s+/;

export function textToAdf(text, names = {}) {
  const blocks = String(text)
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((b) => b.split("\n").filter((l) => l.trim() !== ""))
    .filter((lines) => lines.length);

  const content = blocks.map((lines) => {
    if (lines.every((l) => BULLET.test(l))) {
      return {
        type: "bulletList",
        content: lines.map((l) => ({ type: "listItem", content: [paragraph([l.replace(BULLET, "")], names)] })),
      };
    }
    return paragraph(lines, names);
  });

  return { type: "doc", version: 1, content: content.length ? content : [{ type: "paragraph", content: [] }] };
}
