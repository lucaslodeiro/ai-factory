import type { Store } from "./storage.js";

// A work item is identified by a UUID, but operators reach for the issue number they can see, and
// a UUID copied out of a terminal table loses characters. Both mistakes used to answer "no
// finished executions recorded", which reads as a work item that ran nothing rather than an
// argument that names nothing. An id prefix is already the convention elsewhere in this product,
// where `/factory replace` accepts `<#N|id-prefix>`.
export type WorkItemLookup = { id:string } | { error:string };
const minimumPrefix=8;

export function resolveWorkItem(store:Store,reference:string):WorkItemLookup {
  const value=reference.trim().replace(/^#/,"");
  if (!value) return {error:"Name a work item id, an id prefix or an issue number"};
  if (store.db.prepare("SELECT id FROM work_items WHERE id=?").get(value)) return {id:value};
  // Repository and issue number are unique together, so a number names at most one work item.
  if (/^\d+$/.test(value)) {
    const byIssue=store.db.prepare("SELECT id FROM work_items WHERE issue_number=?").get(Number(value)) as {id:string}|undefined;
    return byIssue ? {id:byIssue.id}
      : {error:`No work item for issue #${value}. The daemon assigns an issue before it becomes one; run \`factory status\` to see which issues it has taken.`};
  }
  if (value.length >= minimumPrefix) {
    const matches=(store.db.prepare("SELECT id FROM work_items").all() as Array<{id:string}>).filter(row=>row.id.startsWith(value));
    if (matches.length===1) return {id:matches[0].id};
    if (matches.length>1) return {error:`${reference} matches ${matches.length} work items. Use more of the id.`};
  }
  return {error:`Unknown work item ${reference}. Run \`factory status\` to list work item ids, or name the issue number.`};
}
