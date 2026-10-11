import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { resolve, relative, dirname, extname, join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const root = resolve(import.meta.dirname, ".."),
  files = new Set<string>(),
  queue: string[] = [];
async function add(path: string) {
  let full = resolve(root, path);
  try {
    await stat(full);
  } catch {
    const candidates = [".ts", ".tsx", ".js", ".json"].map((ext) => full + ext);
    let found = false;
    for (const candidate of candidates) {
      try {
        await stat(candidate);
        full = candidate;
        found = true;
        break;
      } catch {}
    }
    if (!found) throw Error(`Missing package dependency: ${path}`);
  }
  if (!full.startsWith(root + "/"))
    throw Error("Package path leaves repository.");
  const name = relative(root, full);
  if (files.has(name)) return;
  const info = await stat(full);
  if (info.isDirectory()) {
    for (const entry of await readdir(full))
      if (
        ![
          "node_modules",
          ".git",
          ".DS_Store",
          "runtime",
          "out",
          "cache",
        ].includes(entry) &&
        !entry.startsWith(".env")
      )
        await add(join(name, entry));
  } else {
    files.add(name);
    if (/\.(ts|tsx|js|mjs)$/.test(name)) queue.push(name);
  }
}
for (const path of [
  "server",
  "shared",
  "packages/client",
  "web",
  "marketing",
  "index.html",
  "vite.config.ts",
  "tsconfig.web.json",
  "tests",
  "scripts",
  "docs",
  "contracts/src",
  "contracts/test",
  "contracts/artifacts",
  "contracts/reference",
  "vendor/forge-std",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.backend.json",
  "foundry.toml",
  "Dockerfile",
  ".dockerignore",
  ".gitignore",
  ".env.example",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
])
  await add(path);
while (queue.length) {
  const path = queue.shift()!,
    source = await readFile(resolve(root, path), "utf8");
  for (const match of source.matchAll(
    /(?:from\s+|import\s*(?:\(\s*)?)["'](\.{1,2}\/[^"']+)["']/g,
  )) {
    const target = resolve(root, dirname(path), match[1]);
    await add(relative(root, target));
  }
}
await mkdir(resolve(root, "dist"), { recursive: true });
await mkdir(resolve(root, "tmp"), { recursive: true });
const names = [...files].sort(),
  manifest = [];
for (const name of names) {
  const body = await readFile(resolve(root, name));
  manifest.push({
    path: name,
    bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  });
}
await writeFile(
  resolve(root, "dist/chancery-app.manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
await writeFile(
  resolve(root, "tmp/app-package-files.txt"),
  names.join("\n") + "\n",
);
const tarVersion = spawnSync("tar", ["--version"], { encoding: "utf8" });
const ownership = tarVersion.stdout?.includes("bsdtar")
  ? [
      "--uid",
      "0",
      "--gid",
      "0",
      "--uname",
      "root",
      "--gname",
      "root",
      "--no-xattrs",
      "--no-acls",
      "--no-fflags",
    ]
  : ["--owner=0", "--group=0", "--numeric-owner"];
const result = spawnSync(
  "tar",
  [
    ...ownership,
    "--format=ustar",
    "-czf",
    "dist/chancery-app.tar.gz",
    "-T",
    "tmp/app-package-files.txt",
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  },
);
if (result.status !== 0) throw Error("Packaging failed.");
const hash = createHash("sha256")
  .update(await readFile(resolve(root, "dist/chancery-app.tar.gz")))
  .digest("hex");
await writeFile(
  resolve(root, "dist/chancery-app.sha256"),
  `${hash}  chancery-app.tar.gz\n`,
);
console.log(
  `Packaged ${files.size} application files: dist/chancery-app.tar.gz`,
);
