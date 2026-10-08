import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
const source = resolve("marketing"),
  target = resolve("build/site");
// Copy the standalone marketing source into the integrated application build.
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
let html = await readFile(resolve(target, "index.html"), "utf8");
// Link the navigation's main CTA to the working app; keep the illustrative demo as an explicit preview.
html = html.replace(
  /<button([^>]*\bdata-demo\b[^>]*)>Open demo<\/button>/g,
  '<a class="button primary" href="/app/">Open app</a>',
);
await writeFile(resolve(target, "index.html"), html);
console.log("Marketing page prepared at /; dashboard at /app/.");
