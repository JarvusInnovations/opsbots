/**
 * Markdown records with TOML frontmatter between `+++` lines: the gitsheets markdown record
 * format, read and written here with no dependency (specs/skills/opsbot-core.md, Routines).
 *
 * The TOML is the subset a record's frontmatter needs: `key = value` lines with basic and
 * literal strings, whole numbers, booleans, bare dates and times (read as strings) and arrays
 * of those, which may span lines. Anything else (a table, a multi-line string, a dotted key)
 * is refused with a reason, never guessed at.
 *
 * Written output is deterministic: keys sorted, strings double-quoted, arrays on one line,
 * one blank line between the closing `+++` and the body, one newline at the end.
 */

export type TomlValue = string | number | boolean | TomlValue[];
export type Frontmatter = Record<string, TomlValue>;

export interface Parsed {
  data: Frontmatter;
  body: string;
}

export class FrontmatterError extends Error {}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/** Split a record into its frontmatter and body; throws FrontmatterError with a reason. */
export function parseRecord(text: string): Parsed {
  const t = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!t.startsWith("+++\n")) {
    if (t.startsWith("---\n")) throw new FrontmatterError("frontmatter must be TOML between +++ lines, not YAML between ---");
    throw new FrontmatterError("no frontmatter: the file must open with a +++ line");
  }
  const end = t.indexOf("\n+++", 3);
  if (end < 0 || (t[end + 4] !== undefined && t[end + 4] !== "\n")) throw new FrontmatterError("the frontmatter has no closing +++ line");
  const toml = t.slice(4, end + 1);
  const body = t.slice(end + 5).replace(/^\n+/, "").replace(/\n+$/, "");
  return { data: parseToml(toml), body };
}

export function parseToml(src: string): Frontmatter {
  const out: Frontmatter = {};
  let i = 0;
  let line = 1;
  const n = src.length;
  const fail = (msg: string): never => {
    throw new FrontmatterError(`frontmatter line ${line}: ${msg}`);
  };
  const skipWs = () => {
    while (i < n && (src[i] === " " || src[i] === "\t")) i++;
  };
  const skipWsNl = () => {
    for (;;) {
      skipWs();
      if (src[i] === "#") while (i < n && src[i] !== "\n") i++;
      if (src[i] === "\n") {
        i++;
        line++;
        continue;
      }
      break;
    }
  };
  const readBasic = (): string => {
    if (src.startsWith('"""', i)) fail("multi-line strings are not supported in frontmatter");
    i++;
    let s = "";
    while (i < n && src[i] !== '"') {
      const c = src[i]!;
      if (c === "\n") fail("unterminated string");
      if (c === "\\") {
        const e = src[i + 1];
        const map: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
        if (e !== undefined && e in map) {
          s += map[e];
          i += 2;
        } else if (e === "u" || e === "U") {
          const len = e === "u" ? 4 : 8;
          const hex = src.slice(i + 2, i + 2 + len);
          if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) fail(`bad \\${e} escape`);
          s += String.fromCodePoint(parseInt(hex, 16));
          i += 2 + len;
        } else fail(`bad escape \\${e ?? ""}`);
        continue;
      }
      s += c;
      i++;
    }
    if (src[i] !== '"') fail("unterminated string");
    i++;
    return s;
  };
  const readLiteral = (): string => {
    if (src.startsWith("'''", i)) fail("multi-line strings are not supported in frontmatter");
    i++;
    const j = src.indexOf("'", i);
    const nl = src.indexOf("\n", i);
    if (j < 0 || (nl >= 0 && nl < j)) fail("unterminated string");
    const s = src.slice(i, j);
    i = j + 1;
    return s;
  };
  const readValue = (): TomlValue => {
    const c = src[i];
    if (c === '"') return readBasic();
    if (c === "'") return readLiteral();
    if (c === "[") {
      i++;
      const arr: TomlValue[] = [];
      for (;;) {
        skipWsNl();
        if (src[i] === "]") {
          i++;
          return arr;
        }
        arr.push(readValue());
        skipWsNl();
        if (src[i] === ",") {
          i++;
          continue;
        }
        if (src[i] === "]") {
          i++;
          return arr;
        }
        fail("expected , or ] in an array");
      }
    }
    if (c === "{") fail("inline tables are not supported in frontmatter");
    let j = i;
    while (j < n && !/[\s,\]#]/.test(src[j]!)) j++;
    // a datetime may hold one space between its date and time
    if (src[j] === " " && /^\d{4}-\d{2}-\d{2}$/.test(src.slice(i, j)) && /^\d{2}:/.test(src.slice(j + 1, j + 4))) {
      j++;
      while (j < n && !/[\s,\]#]/.test(src[j]!)) j++;
    }
    const tok = src.slice(i, j);
    if (!tok) fail("a value is missing");
    i = j;
    if (tok === "true") return true;
    if (tok === "false") return false;
    if (/^[+-]?\d+$/.test(tok.replace(/_/g, ""))) return Number(tok.replace(/_/g, ""));
    if (DATE_LIKE.test(tok)) return tok;
    return fail(`cannot read the value ${JSON.stringify(tok)} (strings are quoted)`);
  };

  for (;;) {
    skipWsNl();
    if (i >= n) break;
    if (src[i] === "[") fail("tables are not supported in frontmatter");
    let key: string;
    if (src[i] === '"') key = readBasic();
    else if (src[i] === "'") key = readLiteral();
    else {
      let j = i;
      while (j < n && /[A-Za-z0-9_.-]/.test(src[j]!)) j++;
      key = src.slice(i, j);
      if (!key) fail("expected a key");
      if (key.includes(".")) fail(`dotted keys are not supported (${key})`);
      i = j;
    }
    skipWs();
    if (src[i] !== "=") fail(`expected = after ${key}`);
    i++;
    skipWs();
    const v = readValue();
    if (Object.prototype.hasOwnProperty.call(out, key)) fail(`${key} is set twice`);
    out[key] = v;
    skipWs();
    if (src[i] === "#") while (i < n && src[i] !== "\n") i++;
    if (i < n && src[i] !== "\n") fail(`unexpected text after the value of ${key}`);
  }
  return out;
}

function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, "0").toUpperCase()}`;
    else out += ch;
  }
  return `${out}"`;
}

function value(v: TomlValue): string {
  if (typeof v === "string") return quote(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new FrontmatterError(`only whole numbers are written (got ${v})`);
    return String(v);
  }
  return `[${v.map(value).join(", ")}]`;
}

/** One record's bytes: sorted keys, a blank line, the body, one final newline. */
export function serializeRecord(data: Frontmatter, body: string): string {
  const keys = Object.keys(data).sort();
  const lines = keys.map((k) => `${BARE_KEY.test(k) ? k : quote(k)} = ${value(data[k]!)}`);
  const b = body.replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\n+$/, "");
  return `+++\n${lines.join("\n")}\n+++\n${b ? `\n${b}\n` : ""}`;
}
