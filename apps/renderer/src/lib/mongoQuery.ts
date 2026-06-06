// Pure parser for mongosh-style READ commands typed into the query editor.
// No IO / DOM — fully unit-testable.

export type MongoParsed =
  | {
      collection: string;
      op: 'find';
      filter: string;
      projection?: string;
      sort?: string;
      skip?: number;
      limit?: number;
    }
  | { collection: string; op: 'aggregate'; pipeline: string; limit?: number }
  | { collection: string; op: 'count'; filter: string }
  | { error: string };

const ERR_WRITE =
  '쓰기 작업은 쿼리 에디터에서 지원하지 않습니다. 문서 보기에서 추가/편집/삭제하세요.';
const ERR_PARSE = '쿼리를 파싱할 수 없습니다. 예: db.collection.find({ })';

const WRITE_OPS = new Set([
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'replaceOne',
  'drop',
  'remove',
  'save',
  'bulkWrite',
]);

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[\w$]/;

/**
 * Normalize relaxed (mongosh-style) JSON into strict JSON: quote unquoted
 * object keys and convert single-quoted strings to double-quoted. Conservative
 * by design — only identifier keys and single quotes are handled.
 */
export function relaxedJsonToJson(s: string): string {
  let out = '';
  let i = 0;
  const n = s.length;

  while (i < n) {
    const ch = s[i];

    // Already double-quoted string: copy verbatim (with escapes).
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        const c = s[i];
        out += c;
        if (c === '\\' && i + 1 < n) {
          out += s[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (c === '"') break;
      }
      continue;
    }

    // Single-quoted string → double-quoted.
    if (ch === "'") {
      out += '"';
      i++;
      while (i < n) {
        const c = s[i];
        if (c === '\\' && i + 1 < n) {
          // Preserve escape; if it escapes a single quote, emit a bare quote.
          const next = s[i + 1];
          out += next === "'" ? "'" : '\\' + next;
          i += 2;
          continue;
        }
        if (c === "'") {
          out += '"';
          i++;
          break;
        }
        // Escape a literal double quote that appeared inside single quotes.
        out += c === '"' ? '\\"' : c;
        i++;
      }
      continue;
    }

    // Unquoted identifier key: <ident> followed (after ws) by ':'.
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(s[j])) j++;
      const ident = s.slice(i, j);
      let k = j;
      while (k < n && /\s/.test(s[k])) k++;
      if (s[k] === ':') {
        out += '"' + ident + '"';
        i = j;
        continue;
      }
      // Not a key (likely a literal like true/false/null) — copy as-is.
      out += ident;
      i = j;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/** Result of scanning a balanced bracket group starting at an opener. */
interface ScanResult {
  inner: string; // contents between the brackets (exclusive)
  end: number; // index just past the closing bracket
}

const OPENERS: Record<string, string> = { '(': ')', '{': '}', '[': ']' };

/**
 * Scan a balanced bracket group whose opener is at `start`. Respects nested
 * brackets and quoted strings. Returns null if unbalanced.
 */
function scanBalanced(text: string, start: number): ScanResult | null {
  const open = text[start];
  const close = OPENERS[open];
  if (!close) return null;

  let depth = 0;
  let i = start;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < n) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === '(' || ch === '{' || ch === '[') {
      depth++;
    } else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        return { inner: text.slice(start + 1, i), end: i + 1 };
      }
    }
    i++;
  }
  return null;
}

/**
 * Split a top-level argument list on commas, respecting bracket nesting and
 * quoted strings. Returns trimmed argument source strings.
 */
function splitTopLevelArgs(src: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];

    if (ch === '"' || ch === "'") {
      const quote = ch;
      current += ch;
      i++;
      while (i < n) {
        current += src[i];
        if (src[i] === '\\' && i + 1 < n) {
          current += src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;

    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  const last = current.trim();
  if (last.length > 0 || args.length > 0) args.push(last);
  return args;
}

/** Parse + re-stringify a relaxed-JSON argument into canonical JSON. */
type JsonResult = { ok: true; json: string } | { ok: false; error: string };

function canonicalJson(src: string): JsonResult {
  const normalized = relaxedJsonToJson(src);
  try {
    const value = JSON.parse(normalized);
    return { ok: true, json: JSON.stringify(value) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `잘못된 JSON 인자: ${msg}` };
  }
}

/** Read an identifier starting at `i`; returns the ident and the next index. */
function readIdent(text: string, i: number): { ident: string; end: number } {
  let j = i;
  while (j < text.length && IDENT_PART.test(text[j])) j++;
  return { ident: text.slice(i, j), end: j };
}

function skipWs(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/**
 * Parse a mongosh-style read command into a structured request, or an error.
 */
export function parseMongoCommand(text: string): MongoParsed {
  const src = text.trim();

  // db.<collection>.<op>(...)
  if (!src.startsWith('db.')) return { error: ERR_PARSE };
  let i = 3;

  const coll = readIdent(src, i);
  if (!coll.ident || !IDENT_START.test(coll.ident[0])) return { error: ERR_PARSE };
  i = coll.end;

  if (src[i] !== '.') return { error: ERR_PARSE };
  i++;

  const opTok = readIdent(src, i);
  if (!opTok.ident || !IDENT_START.test(opTok.ident[0])) return { error: ERR_PARSE };
  i = opTok.end;
  const opName = opTok.ident;

  if (WRITE_OPS.has(opName)) return { error: ERR_WRITE };

  i = skipWs(src, i);
  if (src[i] !== '(') return { error: ERR_PARSE };
  const argScan = scanBalanced(src, i);
  if (!argScan) return { error: ERR_PARSE };
  i = argScan.end;

  const collection = coll.ident;

  if (opName === 'find') {
    return parseFind(collection, argScan.inner, src, i);
  }
  if (opName === 'aggregate') {
    return parseAggregate(collection, argScan.inner, src, i);
  }
  if (opName === 'countDocuments' || opName === 'count') {
    return parseCount(collection, argScan.inner, src, i);
  }

  return { error: ERR_PARSE };
}

interface ChainCalls {
  sort?: string;
  skip?: number;
  limit?: number;
  error?: string;
}

/** Scan a trailing `.sort(...).skip(n).limit(n)` chain. */
function parseChain(
  src: string,
  start: number,
  allowed: Set<string>,
): ChainCalls {
  const result: ChainCalls = {};
  let i = skipWs(src, start);

  while (i < src.length) {
    i = skipWs(src, i);
    if (i >= src.length) break;
    if (src[i] !== '.') return { error: ERR_PARSE };
    i++;
    const tok = readIdent(src, i);
    if (!tok.ident) return { error: ERR_PARSE };
    i = tok.end;
    if (!allowed.has(tok.ident)) return { error: ERR_PARSE };

    i = skipWs(src, i);
    if (src[i] !== '(') return { error: ERR_PARSE };
    const scan = scanBalanced(src, i);
    if (!scan) return { error: ERR_PARSE };
    i = scan.end;
    const arg = scan.inner.trim();

    if (tok.ident === 'sort') {
      const json = canonicalJson(arg || '{}');
      if (!json.ok) return { error: json.error };
      result.sort = json.json;
    } else {
      // skip / limit expect a number
      const num = Number(arg);
      if (arg === '' || Number.isNaN(num)) return { error: ERR_PARSE };
      if (tok.ident === 'skip') result.skip = num;
      else result.limit = num;
    }
  }

  return result;
}

function parseFind(
  collection: string,
  argInner: string,
  src: string,
  afterArgs: number,
): MongoParsed {
  const args = splitTopLevelArgs(argInner);

  const filterSrc = args.length >= 1 && args[0] !== '' ? args[0] : '{}';
  const filterJson = canonicalJson(filterSrc);
  if (!filterJson.ok) return { error: filterJson.error };

  const out: MongoParsed = { collection, op: 'find', filter: filterJson.json };

  if (args.length >= 2 && args[1] !== '') {
    const projJson = canonicalJson(args[1]);
    if (!projJson.ok) return { error: projJson.error };
    out.projection = projJson.json;
  }

  const chain = parseChain(src, afterArgs, new Set(['sort', 'skip', 'limit']));
  if (chain.error) return { error: chain.error };
  if (chain.sort !== undefined) out.sort = chain.sort;
  if (chain.skip !== undefined) out.skip = chain.skip;
  if (chain.limit !== undefined) out.limit = chain.limit;

  return out;
}

function parseAggregate(
  collection: string,
  argInner: string,
  src: string,
  afterArgs: number,
): MongoParsed {
  const args = splitTopLevelArgs(argInner);
  const pipelineSrc = args.length >= 1 && args[0] !== '' ? args[0] : '[]';
  const pipelineJson = canonicalJson(pipelineSrc);
  if (!pipelineJson.ok) return { error: pipelineJson.error };

  const out: MongoParsed = {
    collection,
    op: 'aggregate',
    pipeline: pipelineJson.json,
  };

  const chain = parseChain(src, afterArgs, new Set(['limit']));
  if (chain.error) return { error: chain.error };
  if (chain.limit !== undefined) out.limit = chain.limit;

  return out;
}

function parseCount(
  collection: string,
  argInner: string,
  src: string,
  afterArgs: number,
): MongoParsed {
  const trailing = src.slice(afterArgs).trim();
  if (trailing !== '') return { error: ERR_PARSE };

  const args = splitTopLevelArgs(argInner);
  const filterSrc = args.length >= 1 && args[0] !== '' ? args[0] : '{}';
  const filterJson = canonicalJson(filterSrc);
  if (!filterJson.ok) return { error: filterJson.error };

  return { collection, op: 'count', filter: filterJson.json };
}
