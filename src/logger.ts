export type LogLevel = "info" | "warn" | "error";
type LogValue = string | number | boolean | null | undefined;

function value(value: LogValue) {
  if (value === undefined) return undefined;
  return typeof value === "string" ? JSON.stringify(value.replace(/[\r\n]+/g," ")) : JSON.stringify(value);
}

export function daemonLog(level: LogLevel,event: string,fields: Record<string,LogValue> = {},timestamp = new Date().toISOString()) {
  const details=Object.entries(fields).map(([key,item])=>{
    const rendered=value(item);
    return rendered === undefined ? "" : `${key}=${rendered}`;
  }).filter(Boolean).join(" ");
  const line=`${timestamp} ${level.toUpperCase().padEnd(5)} ${event}${details ? ` ${details}` : ""}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
