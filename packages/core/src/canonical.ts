// A lone (unpaired) UTF-16 surrogate: not a Unicode scalar value, so JCS must reject it.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function str(s: string): string {
  if (LONE_SURROGATE.test(s))
    throw new TypeError("canonicalJson: string contains a lone surrogate");
  return JSON.stringify(s);
}

function isPlainObject(v: object): v is Record<string, unknown> {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * JCS (RFC 8785) serialization: object keys sorted by UTF-16 code units, ECMAScript number
 * formatting, no whitespace; `undefined` object members are dropped.
 * Rejects inputs JCS can't represent: lone surrogates, non-finite numbers, sparse arrays,
 * and non-plain objects (Date, Map, class instances…).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return str(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) throw new TypeError("canonicalJson: sparse array");
      if (value[i] === undefined) throw new TypeError("canonicalJson: undefined array element");
      parts.push(canonicalJson(value[i]));
    }
    return `[${parts.join(",")}]`;
  }
  if (typeof value === "object") {
    if (!isPlainObject(value))
      throw new TypeError("canonicalJson: only plain objects are supported");
    const entries = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map((k) => `${str(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
}
