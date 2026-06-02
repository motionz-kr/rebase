import * as net from 'net';
import { REDIS } from './dbProbe';

// A tiny, dependency-free RESP client used only by the Redis E2E to seed and
// independently verify keys (so we don't trust the app to check itself). Opens
// a fresh connection per command and parses a single reply: simple string (+),
// error (-), integer (:), or bulk string ($, with $-1 → null). Arrays are not
// needed by the test and are intentionally unsupported.

type Reply = string | number | null;

function encode(args: string[]): Buffer {
  let s = `*${args.length}\r\n`;
  for (const a of args) s += `$${Buffer.byteLength(a)}\r\n${a}\r\n`;
  return Buffer.from(s);
}

// Returns the parsed reply and the number of bytes consumed, or null if the
// buffer does not yet hold a complete reply.
function parseReply(buf: Buffer): { value: Reply; consumed: number } | null {
  const nl = buf.indexOf('\r\n');
  if (nl === -1) return null;
  const type = String.fromCharCode(buf[0]);
  const line = buf.toString('utf8', 1, nl);
  const headerEnd = nl + 2;

  switch (type) {
    case '+':
      return { value: line, consumed: headerEnd };
    case '-':
      return { value: `ERR ${line}`, consumed: headerEnd };
    case ':':
      return { value: Number(line), consumed: headerEnd };
    case '$': {
      const len = Number(line);
      if (len === -1) return { value: null, consumed: headerEnd };
      const dataEnd = headerEnd + len;
      if (buf.length < dataEnd + 2) return null; // wait for data + CRLF
      return { value: buf.toString('utf8', headerEnd, dataEnd), consumed: dataEnd + 2 };
    }
    default:
      throw new Error(`unsupported RESP reply type: ${type}`);
  }
}

export function redisCmd(args: string[], host = REDIS.host, port = REDIS.port): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    let buf = Buffer.alloc(0);
    sock.once('connect', () => sock.write(encode(args)));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      try {
        const parsed = parseReply(buf);
        if (parsed) {
          sock.destroy();
          resolve(parsed.value);
        }
      } catch (e) {
        sock.destroy();
        reject(e);
      }
    });
    sock.once('error', reject);
    sock.setTimeout(3000, () => {
      sock.destroy();
      reject(new Error('redis command timed out'));
    });
  });
}

export const redisSet = (key: string, value: string) => redisCmd(['SET', key, value]);
export const redisGet = (key: string) => redisCmd(['GET', key]);
export const redisDel = (...keys: string[]) => redisCmd(['DEL', ...keys]);
export const redisExists = (key: string) => redisCmd(['EXISTS', key]);
