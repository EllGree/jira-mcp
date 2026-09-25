// Planning a walk through a workflow to a target status.
//
// Only status names are planned here. Transition ids differ between issues and issue types, so the
// id for each step is looked up on the issue itself when that step is reached, never taken from the
// workflow definition.

const norm = (s) => String(s ?? "").trim().toLowerCase();

/**
 * Edges `{ from, to }` by status name from the bulk-workflows response (POST /rest/api/3/workflows).
 * `from: null` is a global transition, reachable from any status. Both the `links[].fromStatusReference`
 * and the older `from[].statusReference` shapes are read.
 */
export function edgesFromWorkflows(response) {
  const names = new Map();
  for (const s of response?.statuses || []) {
    if (s.statusReference) names.set(s.statusReference, s.name);
    if (s.id) names.set(String(s.id), s.name);
  }
  const wf = (response?.workflows || [])[0];
  if (!wf) return null;
  for (const s of wf.statuses || []) {
    if (s.statusReference && s.name) names.set(s.statusReference, s.name);
  }
  const name = (ref) => names.get(ref) ?? names.get(String(ref)) ?? null;

  const edges = [];
  for (const t of wf.transitions || []) {
    if (t.type === "INITIAL") continue;
    const to = name(t.toStatusReference ?? t.to?.statusReference);
    if (!to) continue;
    const froms = [
      ...(t.links || []).map((l) => l.fromStatusReference),
      ...(t.from || []).map((f) => f.statusReference ?? f),
    ].filter((r) => r !== undefined && r !== null);
    if (t.type === "GLOBAL" || !froms.length) edges.push({ from: null, to, name: t.name });
    else for (const f of froms) edges.push({ from: name(f), to, name: t.name });
  }
  return edges;
}

/** Shortest list of status names to pass through, ending with `target`; [] if already there, null if unreachable. */
export function statusPath(edges, current, target) {
  if (norm(current) === norm(target)) return [];
  const prev = new Map([[norm(current), null]]);
  const label = new Map([[norm(current), current]]);
  const queue = [norm(current)];
  while (queue.length) {
    const at = queue.shift();
    for (const e of edges) {
      if (e.from !== null && norm(e.from) !== at) continue;
      const next = norm(e.to);
      if (prev.has(next)) continue;
      prev.set(next, at);
      label.set(next, e.to);
      if (next === norm(target)) {
        const path = [];
        for (let n = next; n !== norm(current); n = prev.get(n)) path.unshift(label.get(n));
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}
