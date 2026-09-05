import express, { type Express } from "express";
import { existsSync } from "node:fs";
import { resolve, extname } from "node:path";
/** Serve the app and marketing release on the API origin; API routes never fall back to HTML. */
export function registerWeb(app: Express, root = resolve("build")) {
  const dashboard = resolve(root, "app"),
    site = resolve(root, "site");
  const headers = (res: express.Response) => {
    res.set({
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
      "Cache-Control": "no-cache",
    });
  };
  if (existsSync(resolve(dashboard, "index.html"))) {
    app.get(/^\/app$/, (_req, res) => res.redirect(302, "/app/"));
    app.use(
      "/app",
      express.static(dashboard, {
        index: "index.html",
        dotfiles: "deny",
        setHeaders: headers,
      }),
    );
    app.use("/app", (req, res, next) => {
      if (!["GET", "HEAD"].includes(req.method) || extname(req.path))
        return next();
      headers(res);
      res.sendFile(resolve(dashboard, "index.html"));
    });
  }
  if (existsSync(resolve(site, "index.html")))
    app.use((req, res, next) => {
      if (
        req.path === "/api" ||
        req.path.startsWith("/api/") ||
        req.path === "/app" ||
        req.path.startsWith("/app/") ||
        ["/ready", "/health"].includes(req.path)
      )
        return next();
      express.static(site, {
        index: "index.html",
        dotfiles: "deny",
        setHeaders: headers,
      })(req, res, next);
    });
}
