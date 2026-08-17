import { scanSecrets } from "./secret-scan.ts";
// Return only the category of sensitive content, never the matched value.
const API_KEY =
  /\bsk-ant-[A-Za-z0-9_-]{10,}\b|\bsk-[A-Za-z0-9_-]{10,}\b|\bghp_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bAKIA[A-Z0-9]{12,}\b|\bxox[bpa]-[A-Za-z0-9-]{10,}\b|\bAIza[A-Za-z0-9_-]{20,}\b/;
export function checkGuards(
  ...text: string[]
): { kind: string; message: string } | null {
  const seed = scanSecrets(...text);
  if (seed)
    return {
      kind: seed.kind,
      message:
        seed.kind === "seed"
          ? "A seed phrase was detected. Remove it before sending."
          : "Possible private key detected. Remove it or label a public transaction hash explicitly.",
    };
  if (text.some((t) => API_KEY.test(t)))
    return {
      kind: "api_key",
      message: "An API secret was detected. Remove it before sending.",
    };
  return null;
}
