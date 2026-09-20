import path from "node:path";
import { fileURLToPath } from "node:url";

export const engine=path.resolve(fileURLToPath(new URL("..",import.meta.url)));
export const home=process.env.AI_FACTORY_HOME?.trim()
  ? path.resolve(process.env.AI_FACTORY_HOME)
  : path.basename(engine)==="engine" ? path.dirname(engine) : engine;
export const environmentFile=path.join(home,".env");
export const dataDirectory=path.join(home,"data");
