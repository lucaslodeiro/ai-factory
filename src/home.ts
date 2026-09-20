import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function locateEngine(start: string) {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current,"package.json")) && fs.existsSync(path.join(current,"src"))) return current;
    const parent=path.dirname(current);
    if(parent===current) throw new Error("Could not locate the AI Factory engine directory");
    current=parent;
  }
}

export function factoryEngineRoot() {
  return locateEngine(path.dirname(fileURLToPath(import.meta.url)));
}

export function factoryHome(engineDirectory = factoryEngineRoot(), environment: NodeJS.ProcessEnv = process.env) {
  if (environment.AI_FACTORY_HOME?.trim()) return path.resolve(environment.AI_FACTORY_HOME);
  const engine=path.resolve(engineDirectory);
  return path.basename(engine)==="engine" ? path.dirname(engine) : engine;
}

export function resolveFromFactoryHome(value:string,engineDirectory=factoryEngineRoot()) {
  return path.resolve(factoryHome(engineDirectory),value);
}
