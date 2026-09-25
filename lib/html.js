// Jira's renderedFields HTML to readable text.
//
// Images are the reason this exists as more than a tag strip: an inline screenshot in a rendered
// description points at /rest/api/3/attachment/content/<id> (or /secure/attachment/<id>/...), and
// the reader needs that id to download it. So an image survives as `[image: attachment <id>]`.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

export function attachmentIdFromSrc(src) {
  const m = /\/attachment\/content\/(\d+)|\/secure\/attachment\/(\d+)|\/attachment\/thumbnail\/(\d+)/.exec(src || "");
  return m ? m[1] || m[2] || m[3] : null;
}

export function htmlToText(html) {
  if (!html) return "";
  let s = String(html);
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc="([^"]*)"/i.exec(tag)?.[1];
    const alt = /\balt="([^"]*)"/i.exec(tag)?.[1];
    const id = attachmentIdFromSrc(src);
    return id ? `[image: attachment ${id}]` : `[image: ${alt || src || "?"}]`;
  });
  s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const label = text.replace(/<[^>]+>/g, "").trim();
    const h = decode(href);
    return !label || label === h ? h : `${label} (${h})`;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<h([1-6])\b[^>]*>/gi, (_, n) => "\n" + "#".repeat(Number(n)) + " ");
  s = s.replace(/<\/(p|div|h[1-6]|ul|ol|table|tr|pre|blockquote)>/gi, "\n");
  s = s.replace(/<\/t[dh]>/gi, " | ");
  s = s.replace(/<[^>]+>/g, "");
  s = decode(s);
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
