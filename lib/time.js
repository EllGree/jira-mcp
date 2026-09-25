// The worklog `started` field is parsed as Java's yyyy-MM-dd'T'HH:mm:ss.SSSZ, where Z is a numeric
// offset without a colon. `+02:00` is refused with an error that names the pattern but not the
// problem, and a trailing literal `Z` is refused too. This takes the forms people actually write and
// produces the one Jira accepts, keeping the wall-clock time as given.

const FORM = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

function localOffset(date, hh, mm, ss) {
  const d = new Date(`${date}T${hh}:${mm}:${ss}`);
  const minutes = -d.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")}`;
}

/** `started` in the form Jira accepts; with no offset given, the machine's own offset on that date. */
export function jiraStarted(input) {
  const m = FORM.exec(String(input).trim());
  if (!m) throw new Error(`started: cannot read "${input}", expected e.g. 2026-09-25T13:00 or 2026-09-25T13:00:00+02:00`);
  const [, date, hh, mm, ss = "00", ms = "0", zone] = m;
  let offset;
  if (!zone) offset = localOffset(date, hh, mm, ss);
  else if (zone.toUpperCase() === "Z") offset = "+0000";
  else offset = zone.replace(":", "");
  return `${date}T${hh}:${mm}:${ss}.${ms.padEnd(3, "0")}${offset}`;
}
