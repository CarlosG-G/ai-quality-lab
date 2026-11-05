import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ShopBot } from './bot.ts';
import { createProvider } from './providers/index.ts';

const MAX_BODY_BYTES = 4096;
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  const payload = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Payload too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body must be valid JSON');
  }
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createApp(bot: ShopBot) {
  return createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && pathname === '/') return send(res, 200, html, 'text/html');
      if (req.method === 'GET' && pathname === '/api/health') return send(res, 200, { status: 'ok', provider: bot.providerName });
      if (pathname === '/api/chat') {
        if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
        const body = (await readJson(req)) as { message?: unknown } | null;
        const result = await bot.ask(body?.message);
        return send(res, result.reason === 'invalid_input' ? 400 : 200, result);
      }
      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      return send(res, 502, { error: 'The assistant is unavailable right now' });
    }
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  const bot = new ShopBot({ provider: createProvider() });
  createApp(bot).listen(port, () => console.log(`ShopBot (${bot.providerName}) on http://localhost:${port}`));
}
