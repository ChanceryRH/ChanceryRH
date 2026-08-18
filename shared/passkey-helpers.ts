import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";

export function passkeysAvailable({ origin }: { origin: string }): boolean {
  try {
    const url = new URL(origin),
      host = url.hostname.replace(/^\[|\]$/g, "");
    return (
      !url.username &&
      !url.password &&
      !isIP(host) &&
      !!host &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          (host === "localhost" || host.endsWith(".localhost"))))
    );
  } catch {
    return false;
  }
}
export const newHandle = () => randomBytes(32).toString("base64url");
const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function encoded(value: unknown, max: number, empty = false): value is string {
  return (
    typeof value === "string" &&
    (empty || value.length > 0) &&
    value.length <= max &&
    /^[\w-]*$/.test(value) &&
    Buffer.from(value, "base64url").toString("base64url") === value
  );
}
/** Copy validated credential fields so extensions cannot pass arbitrary nested data through. */



