// A Builder starts every execution with fresh context and no memory of the target repository, so
// it rediscovers the layout before it can act. This is that layout, stated once in the prompt.
//
// It is deliberately a map, not an index: directories, how many tracked files each holds and which
// kinds, never file contents. The prompt sits at the head of an agentic conversation and is re-read
// on every turn, so this has to stay small enough that a few saved exploration turns pay for it.
// Directories are rendered as "<path> <tracked files> <kinds>" rather than as objects: the map is
// re-read on every turn, and the dense form costs less than half the bytes of the structured one
// while staying just as readable to a model.
export interface RepositoryMap { legend:string; files:number; rootFiles:string[]; directories:string[]; truncated:boolean }

export const repositoryMapLimits = { directories:40, rootFiles:25, kinds:4, depth:2 } as const;

const extension = (file:string) => { const name=file.slice(file.lastIndexOf("/")+1),dot=name.lastIndexOf("."); return dot>0 ? name.slice(dot) : ""; };

export function buildRepositoryMap(trackedFiles:string[],limits=repositoryMapLimits):RepositoryMap|undefined {
  const files=trackedFiles.map(file=>file.trim()).filter(Boolean);
  if (!files.length) return undefined;
  const rootFiles=files.filter(file=>!file.includes("/")).sort();
  const grouped=new Map<string,{files:number;kinds:Map<string,number>}>();
  for (const file of files) {
    const segments=file.split("/");
    if (segments.length < 2) continue;
    // Deeper trees roll up into their ancestor at the depth limit, so a nested project still
    // reports one honest total instead of hundreds of leaf rows or nothing at all.
    const path=segments.slice(0,Math.min(limits.depth,segments.length-1)).join("/");
    const entry=grouped.get(path) ?? {files:0,kinds:new Map<string,number>()};
    entry.files+=1;
    const kind=extension(file);
    if (kind) entry.kinds.set(kind,(entry.kinds.get(kind) ?? 0)+1);
    grouped.set(path,entry);
  }
  const ranked=[...grouped.entries()]
    .sort((a,b)=>b[1].files-a[1].files || a[0].localeCompare(b[0]))
    .map(([path,entry])=>[path,entry.files,
      [...entry.kinds.entries()].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,limits.kinds).map(([kind])=>kind).join(" ")]
      .filter(part=>part !== "").join(" "));
  return {legend:"directory, tracked files, most common extensions",files:files.length,
    rootFiles:rootFiles.slice(0,limits.rootFiles),directories:ranked.slice(0,limits.directories),
    truncated:ranked.length>limits.directories || rootFiles.length>limits.rootFiles};
}
