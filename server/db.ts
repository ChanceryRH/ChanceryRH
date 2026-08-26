import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
export interface Query {
  query<T = any>(text: string, params?: any[]): Promise<T[]>;
}
export interface Database extends Query {
  transaction<T>(fn: (q: Query) => Promise<T>): Promise<T>;
  office<T>(id: string, fn: (q: Query) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  migrate(): Promise<void>;
}
export async function openDatabase(url: string): Promise<Database> {
  let transaction: Database["transaction"];
  let query: Query["query"];
  let close: Database["close"];
  let exec: (sql: string) => Promise<unknown>;
  if (url.startsWith("pglite://")) {
    const path = url.slice(9);
    if (path !== "memory")
      await mkdir(dirname(resolve(path)), { recursive: true });
    const pg = new PGlite(path === "memory" ? undefined : path);
    await pg.waitReady;
    query = async (sql, p = []) => (await pg.query(sql, p)).rows as any;
    transaction = async (fn) =>
      pg.transaction(async (tx) =>
        fn({
          query: async (sql, p = []) => (await tx.query(sql, p)).rows as any,
        }),
      );
    exec = (sql) => pg.exec(sql);
    close = () => pg.close();
  } else {
    // SQL callers pass JSON.stringify values, matching PGlite's text protocol. Avoid double encoding in postgres.js.
    const pg = postgres(url, {
      max: 10,
      idle_timeout: 20,
      onnotice: () => {},
      types: {
        json: {
          to: 114,
          from: [114, 3802],
          serialize: (value: any) =>
            typeof value === "string" ? value : JSON.stringify(value),
          parse: JSON.parse,
        },
      },
      transform: { undefined: null },
    });
    query = async (sql, p = []) => (await pg.unsafe(sql, p)) as any;
    transaction = async (fn) =>
      (await pg.begin(async (tx) =>
        fn({ query: async (sql, p = []) => (await tx.unsafe(sql, p)) as any }),
      )) as any;
    exec = async (sql) => {
      const connection = await pg.reserve();
      try {
        return await connection.unsafe(sql).simple();
      } catch (error) {
        await connection.unsafe("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        connection.release();
      }
    };
    close = () => pg.end({ timeout: 5 });
  }
  const rawTransaction = transaction;
  const serviceTransaction: Database["transaction"] = (fn) =>
    rawTransaction(async (q) => {
      await q.query("SET LOCAL ROLE chancery_service");
      return fn(q);
    });
  return {
    query: (sql, p) => serviceTransaction((q) => q.query(sql, p)),
    transaction: serviceTransaction,
    close,
    async migrate() {
      const directory = new URL("./migrations/", import.meta.url);
      for (const file of (await readdir(directory))
        .filter((x) => x.endsWith(".sql"))
        .sort())
        await exec(await readFile(new URL(file, directory), "utf8"));
    },
    async office(id, fn) {
      return rawTransaction(async (q) => {
        await q.query("SELECT set_config('chancery.office_id', $1, true)", [
          id,
        ]);
        await q.query("SET LOCAL ROLE chancery_office");
        return fn(q);
      });
    },
  };
}
