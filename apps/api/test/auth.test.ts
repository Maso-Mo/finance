import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';

const COOKIE_NAME = 'finance_refresh';
const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct-horse-battery-staple';

// La réponse API ne doit JAMAIS contenir de hash de mot de passe.
function expectNoSecrets(body: unknown): void {
  expect(JSON.stringify(body)).not.toContain('passwordHash');
}

function getRefreshToken(res: request.Response): string {
  const setCookies: string[] = Array.isArray(res.headers['set-cookie'])
    ? (res.headers['set-cookie'] as string[])
    : [res.headers['set-cookie'] as string];
  const cookie = setCookies.find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!cookie) {
    throw new Error('No refresh cookie in response.');
  }
  return cookie.slice(COOKIE_NAME.length + 1).split(';')[0] as string;
}

beforeAll(async () => {
  // Base de test dédiée : on repart d'un état vide et déterministe.
  await prisma.refreshSession.deleteMany();
  await prisma.accountTransfer.deleteMany();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('auth register', () => {
  it('inscription valide → 201, accessToken + user, cookie HttpOnly, aucun secret', async () => {
    const res = await request(app)
      .post('/auth/register')
      .set('Origin', ORIGIN)
      .send({ email: 'alice@example.com', password: PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.email).toBe('alice@example.com');
    expect(res.body.user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expectNoSecrets(res.body);

    const setCookies = (res.headers['set-cookie'] as unknown as string[]).join(' ');
    expect(setCookies).toContain(`${COOKIE_NAME}=`);
    expect(setCookies).toContain('HttpOnly');
    expect(setCookies).toContain('SameSite=Lax');
    expect(setCookies).toContain('Path=/auth');
  });

  it('email déjà utilisé → 409', async () => {
    const res = await request(app)
      .post('/auth/register')
      .set('Origin', ORIGIN)
      .send({ email: 'alice@example.com', password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error).toBeTruthy();
    expectNoSecrets(res.body);
  });

  it('email invalide ou mot de passe court → 400', async () => {
    const badEmail = await request(app)
      .post('/auth/register')
      .send({ email: 'pas-un-email', password: PASSWORD });
    expect(badEmail.status).toBe(400);

    const shortPw = await request(app)
      .post('/auth/register')
      .send({ email: 'short@example.com', password: '123' });
    expect(shortPw.status).toBe(400);
    expectNoSecrets(shortPw.body);
  });
});

describe('auth login', () => {
  it('mauvais mot de passe → 401 générique (email non divulgué)', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'alice@example.com', password: 'mauvais-mot-de-passe' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid email or password.');
    expectNoSecrets(res.body);
  });

  it('email inconnu → 401 identique', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'inconnu@example.com', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid email or password.');
  });

  it('login valide → 200, accessToken, casse d’email insensible', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'ALICE@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.email).toBe('alice@example.com');
    expectNoSecrets(res.body);
  });
});

describe('auth me', () => {
  let accessToken = '';

  beforeAll(async () => {
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'alice@example.com', password: PASSWORD });
    accessToken = login.body.accessToken as string;
  });

  it('/auth/me sans token → 401', async () => {
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
    expectNoSecrets(res.body);
  });

  it('/auth/me avec access token valide → 200', async () => {
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('alice@example.com');
    expectNoSecrets(res.body);
  });

  it('/auth/me avec token invalide → 401', async () => {
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', 'Bearer token.invalide');
    expect(res.status).toBe(401);
  });
});

describe('refresh token rotation', () => {
  it('refresh valide → 200, rotation : l’ancien token devient inutilisable', async () => {
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'alice@example.com', password: PASSWORD });
    const firstToken = getRefreshToken(login);

    const first = await request(app)
      .post('/auth/refresh')
      .set('Origin', ORIGIN)
      .set('Cookie', `${COOKIE_NAME}=${firstToken}`);
    expect(first.status).toBe(200);
    expect(first.body.accessToken).toBeTruthy();
    expectNoSecrets(first.body);
    const rotatedToken = getRefreshToken(first);

    const reuseOld = await request(app)
      .post('/auth/refresh')
      .set('Origin', ORIGIN)
      .set('Cookie', `${COOKIE_NAME}=${firstToken}`);
    expect(reuseOld.status).toBe(401);

    const second = await request(app)
      .post('/auth/refresh')
      .set('Origin', ORIGIN)
      .set('Cookie', `${COOKIE_NAME}=${rotatedToken}`);
    expect(second.status).toBe(200);
  });

  it('refresh sans cookie → 401', async () => {
    const res = await request(app).post('/auth/refresh');
    expect(res.status).toBe(401);
  });

  it('protection CSRF : Origin non autorisé → 403', async () => {
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'alice@example.com', password: PASSWORD });
    const token = getRefreshToken(login);

    const evil = await request(app)
      .post('/auth/refresh')
      .set('Origin', 'http://site-malveillant.example')
      .set('Cookie', `${COOKIE_NAME}=${token}`);
    expect(evil.status).toBe(403);
  });
});

describe('auth logout', () => {
  it('logout révoque la session (refresh ensuite refusé) → 204', async () => {
    const register = await request(app)
      .post('/auth/register')
      .set('Origin', ORIGIN)
      .send({ email: 'bob@example.com', password: PASSWORD });
    expect(register.status).toBe(201);
    const token = getRefreshToken(register);

    const logout = await request(app)
      .post('/auth/logout')
      .set('Origin', ORIGIN)
      .set('Cookie', `${COOKIE_NAME}=${token}`);
    expect(logout.status).toBe(204);

    const after = await request(app)
      .post('/auth/refresh')
      .set('Origin', ORIGIN)
      .set('Cookie', `${COOKIE_NAME}=${token}`);
    expect(after.status).toBe(401);
  });
});
