import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { corsConfig } from '../src/config.js';
const lan = 'http://192.0.2.10:5173'; // Documentation-only test address, never runtime configuration.
corsConfig.origin.push(lan);
afterAll(() => { corsConfig.origin.splice(corsConfig.origin.indexOf(lan), 1); });
describe('explicit local and LAN origins', () => {
  for (const origin of ['http://localhost:5173', lan]) {
    for (const path of ['/auth/register', '/auth/login', '/auth/refresh']) it(`accepts browser preflight ${origin} ${path}`, async () => {
      const res = await request(app).options(path).set({ Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' });
      expect(res.status).toBe(204); expect(res.headers['access-control-allow-origin']).toBe(origin); expect(res.headers['access-control-allow-credentials']).toBe('true');
    });
  }
  it('refuses foreign origins on preflight and cookie requests', async () => {
    expect((await request(app).options('/auth/login').set({ Origin: 'https://foreign.invalid', 'Access-Control-Request-Method': 'POST' })).status).toBe(403);
    expect((await request(app).post('/auth/refresh').set('Origin', 'https://foreign.invalid')).status).toBe(403);
  });
});
