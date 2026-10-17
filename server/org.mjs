// The org chart the server checks units against: org-data.js (the same file the pages use),
// or the chart saved on admin.html (settings.mjs calls applyOrg). The exports are live bindings.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const SOURCE = readFileSync(join(import.meta.dirname, '..', 'org-data.js'), 'utf8');
const ctx = {};
ctx.window = ctx;
vm.runInNewContext(SOURCE, ctx);
// The data part of org-data.js, as plain JSON
export const FILE_ORG = JSON.parse(JSON.stringify({ staffGroups: ctx.ORG.staffGroups, subUnits: ctx.ORG.subUnits, faculties: ctx.ORG.faculties }));
// The helper functions at the end of org-data.js, reused when /org-data.js is built from a saved chart
export const ORG_HELPERS = SOURCE.slice(SOURCE.indexOf('// Helpers'));

const majorName = (m) => (typeof m === 'string' ? m : m.name);
export let ORG, STAFF_UNITS, FACULTIES, STAFF_SEND_UNITS;

export function applyOrg(data) {
  ORG = { ...data, majorName };
  STAFF_UNITS = new Set(ORG.staffGroups.flatMap((g) => g.units));
  FACULTIES = new Set(Object.keys(ORG.faculties));
  // Units a staff member may send work for: any unit, or a sub-unit listed under its parent (submit.html)
  STAFF_SEND_UNITS = new Set([...STAFF_UNITS, ...Object.values(ORG.subUnits).flatMap((s) => s.units)]);
}
applyOrg(FILE_ORG);

export const majorsOf = (faculty) => (ORG.faculties[faculty]?.majors || []).map(majorName);
export const tracksOf = (faculty, major) => {
  const m = (ORG.faculties[faculty]?.majors || []).find((x) => majorName(x) === major);
  return m && typeof m === 'object' ? m.tracks : [];
};
// A unit and its sub-units (a coordinator of a unit sees work sent by its sub-units too)
export const unitFamily = (unit) => [unit, ...(ORG.subUnits[unit]?.units || [])];
// Every unit name news can carry: staff units, sub-units and faculties
export const allUnits = () => [...new Set([...STAFF_SEND_UNITS, ...FACULTIES])];
