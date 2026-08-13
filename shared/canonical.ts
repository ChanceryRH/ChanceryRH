/** Stable JSON for signed records. Reject ambiguous or cyclic input. */
export function canonicalJson(value: unknown): string {
  const active = new WeakSet<object>();
  function visit(input: unknown, depth: number): unknown {
    if (depth > 100)
      throw new RangeError("Signed record nesting exceeds 100 levels.");
    if (typeof input === "bigint") return input.toString();
    if (typeof input === "number" && !Number.isFinite(input))
      throw new TypeError("Signed records require finite numbers.");
    if (input === null || typeof input !== "object") {
      if (["function", "symbol"].includes(typeof input))
        throw new TypeError("Unsupported signed record value.");
      return input;
    }
    if (active.has(input))
      throw new TypeError("Signed records cannot contain cycles.");
    active.add(input);
    try {
      if (Array.isArray(input))
        return input.map((item) => visit(item, depth + 1));
      const proto = Object.getPrototypeOf(input);
      if (proto !== Object.prototype && proto !== null)
        throw new TypeError("Signed records require plain objects.");
      const output = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(input).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        if (!("value" in descriptor))
          throw new TypeError("Signed records cannot contain getters.");
        if (descriptor.value !== undefined)
          output[key] = visit(descriptor.value, depth + 1);
      }
      return output;
    } finally {
      active.delete(input);
    }
  }
  const result = JSON.stringify(visit(value, 0));
  if (result === undefined)
    throw new TypeError("Signed record has no JSON representation.");
  return result;
}
