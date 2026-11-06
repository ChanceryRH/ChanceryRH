import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
const source = resolve("marketing"), target = resolve("build/site");
// The source contains the real app links; builds preserve them without copy rewrites.
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
console.log("Marketing page prepared at /; dashboard at /app/.");
