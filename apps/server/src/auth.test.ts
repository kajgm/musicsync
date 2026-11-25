import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { describe, expect, it } from 'vitest';
import { registerAuth } from './auth.ts';
import type { Config } from './config.ts';

const config = { publicUrl: 'http://127.0.0.1:3000', adminPasswordHash: '', version: 'test' } as Config;

async function app() {
  const app = Fastify();
  await app.register(cookie, { secret: 'test-secret' });
  registerAuth(app, config);
  app.get('/api/agent-token', async () => ({ token: 'secret' }));
  app.get('/api/plan/:floorId', async () => 'plan');
  return app;
}

describe('registerAuth', () => {
  it('refuses every API route without a session, however the path is spelled', async () => {
    const a = await app();
    for (const url of ['/api/agent-token', '/%61pi/agent-token', '/api/agent%2Dtoken', '/api/plan/f1', '/api/agent-token?x=1']) {
      expect((await a.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
  });

  it('lets the session check through without signing in', async () => {
    const a = await app();
    expect((await a.inject({ method: 'GET', url: '/api/session' })).json()).toEqual({ signedIn: false, version: 'test' });
  });
});
