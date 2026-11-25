// One household password and a signed, httpOnly session cookie (architecture §11).
// The loopback agent authenticates with its own token instead (sensors.ts).
import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.ts';

const COOKIE = 'musicsync_session';
const SESSION_DAYS = 90;
const PUBLIC_PATHS = new Set(['/api/login', '/api/logout', '/api/session', '/api/agent']);

export function isSignedIn(req: FastifyRequest): boolean {
  const raw = req.cookies[COOKIE];
  if (!raw) return false;
  const { valid, value } = req.unsignCookie(raw);
  return valid && Number(value) > Date.now();
}

export function registerAuth(app: FastifyInstance, config: Config): void {
  const secure = config.publicUrl.startsWith('https:');
  let failures: number[] = [];

  app.addHook('onRequest', async (req, reply) => {
    // The matched route, not the raw URL: the router decodes %-escapes, so /%61pi/x reaches /api/x.
    const path = req.routeOptions.url ?? '';
    if (path.startsWith('/api/') && !PUBLIC_PATHS.has(path) && !isSignedIn(req)) {
      return reply.code(401).send({ error: 'Sign in first' });
    }
  });

  app.post('/api/login', async (req, reply) => {
    const now = Date.now();
    failures = failures.filter((t) => now - t < 60_000);
    if (failures.length >= 10) return reply.code(429).send({ error: 'Too many attempts. Wait a minute.' });
    const body = z.object({ password: z.string().max(200) }).safeParse(req.body);
    if (!body.success || !(await bcrypt.compare(body.data.password, config.adminPasswordHash))) {
      failures.push(now);
      return reply.code(401).send({ error: 'Wrong password' });
    }
    reply.setCookie(COOKIE, String(now + SESSION_DAYS * 86_400_000), {
      signed: true,
      httpOnly: true,
      secure,
      sameSite: 'lax', // Lax, so the cookie comes back with the redirect from Spotify's login
      path: '/',
      maxAge: SESSION_DAYS * 86_400,
    });
    return reply.code(204).send();
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/session', async (req) => ({ signedIn: isSignedIn(req), version: config.version }));
}
