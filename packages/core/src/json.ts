/**
 * Strict I-JSON (RFC 7493) parsing for verifier entry points (SPEC §6.1).
 *
 * `JSON.parse` silently keeps the last of duplicate member names, maps `1e400` to Infinity and
 * accepts lone surrogates — so two parsers could read different receipts from the same bytes.
 * This parser rejects all three, plus invalid UTF-8 and a byte order mark when given bytes.
 */

export class JsonInputError extends SyntaxError {
  constructor(message: string) {
    super(message);
    this.name = "JsonInputError";
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const MAX_DEPTH = 1000;

/** Parses I-JSON text: no duplicate member names, no lone surrogates, only finite numbers. */
export function parseStrictJson(text: string): unknown {
  let i = 0;
  const fail = (msg: string): never => {
    throw new JsonInputError(`invalid I-JSON at offset ${i}: ${msg}`);
  };
  const ws = () => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };
  const string = (): string => {
    const start = i;
    i++; // opening quote
    for (;;) {
      if (i >= text.length) fail("unterminated string");
      const c = text.charCodeAt(i);
      if (c === 0x22) break;
      if (c === 0x5c) i += 2;
      else i++;
    }
    i++; // closing quote
    let s: string;
    try {
      s = JSON.parse(text.slice(start, i)) as string;
    } catch {
      i = start;
      return fail("malformed string");
    }
    if (LONE_SURROGATE.test(s)) {
      i = start;
      fail("string contains a lone surrogate");
    }
    return s;
  };
  const value = (depth: number): unknown => {
    if (depth > MAX_DEPTH) fail("nesting too deep");
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const out: Record<string, unknown> = {};
      const seen = new Set<string>();
      ws();
      if (text[i] === "}") {
        i++;
        return out;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail("expected a member name");
        const at = i;
        const key = string();
        if (seen.has(key)) {
          i = at;
          fail(`duplicate member name ${JSON.stringify(key)}`);
        }
        seen.add(key);
        ws();
        if (text[i] !== ":") fail("expected ':'");
        i++;
        // defineProperty, so "__proto__" is an ordinary member and never a prototype.
        Object.defineProperty(out, key, {
          value: value(depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return out;
        }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const out: unknown[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return out;
      }
      for (;;) {
        out.push(value(depth + 1));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return out;
        }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') return string();
    for (const [lit, v] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(lit, i)) {
        i += lit.length;
        return v;
      }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) return fail("unexpected character");
    const n = Number(m[0]);
    if (!Number.isFinite(n)) fail(`number ${m[0]} is outside the IEEE 754 double range`);
    i += m[0].length;
    return n;
  };
  const out = value(0);
  ws();
  if (i !== text.length) fail("unexpected data after the JSON value");
  return out;
}

/** Parses UTF-8 bytes as I-JSON: invalid UTF-8 and a byte order mark are rejected too. */
export function parseStrictJsonBytes(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new JsonInputError("input is not valid UTF-8");
  }
  if (text.startsWith("\uFEFF")) throw new JsonInputError("a byte order mark is not allowed");
  return parseStrictJson(text);
}
