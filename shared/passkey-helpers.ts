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
export function cleanResponse(
  value: unknown,
  kind: "create",
): RegistrationResponseJSON | null;
export function cleanResponse(
  value: unknown,
  kind: "get",
): AuthenticationResponseJSON | null;
export function cleanResponse(
  value: unknown,
  kind: "create" | "get",
): RegistrationResponseJSON | AuthenticationResponseJSON | null {
  if (
    !object(value) ||
    !object(value.response) ||
    !encoded(value.id, 1400) ||
    value.rawId !== value.id ||
    value.type !== "public-key"
  )
    return null;
  const inner = value.response;
  if (!encoded(inner.clientDataJSON, 8192)) return null;
  const response: Record<string, any> = {
    clientDataJSON: inner.clientDataJSON,
  };
  const fields =
    kind === "create"
      ? { attestationObject: 65536 }
      : { authenticatorData: 8192, signature: 8192 };
  for (const [field, limit] of Object.entries(fields)) {
    if (!encoded(inner[field], limit!)) return null;
    response[field] = inner[field];
  }
  if (kind === "create" && inner.transports !== undefined) {
    if (
      !Array.isArray(inner.transports) ||
      inner.transports.length > 8 ||
      inner.transports.some(
        (item) => typeof item !== "string" || item.length > 20,
      )
    )
      return null;
    response.transports = [...inner.transports];
  }
  if (kind === "get" && inner.userHandle != null) {
    if (!encoded(inner.userHandle, 128, true)) return null;
    response.userHandle = inner.userHandle;
  }
  if (
    value.clientExtensionResults !== undefined &&
    !object(value.clientExtensionResults)
  )
    return null;
  return {
    id: value.id,
    rawId: value.id,
    type: "public-key",
    response,
    clientExtensionResults: {},
  } as RegistrationResponseJSON | AuthenticationResponseJSON;
}
export function challengeOf(value: unknown): string | null {
  if (
    !object(value) ||
    !object(value.response) ||
    !encoded(value.response.clientDataJSON, 8192)
  )
    return null;
  try {
    const client = JSON.parse(
      Buffer.from(value.response.clientDataJSON, "base64url").toString("utf8"),
    );
    return object(client) && encoded(client.challenge, 128)
      ? client.challenge
      : null;
  } catch {
    return null;
  }
}
export function counterRegressed(stored: number, next: number): boolean {
  if (
    ![stored, next].every(
      (value) =>
        Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff,
    )
  )
    return true;
  return (stored !== 0 || next !== 0) && next <= stored;
}
