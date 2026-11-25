import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import { beginGoogle, exchangeGoogleCode, googleConfig, googleDestination, readGoogleFlow } from '../src/services/google-auth';

const origin = 'http://localhost:3000';
const render = 'https://juee-pos-web.onrender.com';
const web = 'https://juee-pos-web.netlify.app';
const credentials = { GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' };

test('Google authorization requires provider settings and returns only to the customer dashboard', () => {
  assert.equal(googleConfig({ WEB_ORIGIN: origin, GOOGLE_CLIENT_ID: 'test-client' }), undefined);
  assert.equal(googleConfig({ WEB_ORIGIN: origin, ...credentials })?.callback, origin + '/api/v1/auth/google/callback');
  const hosted = { WEB_ORIGIN: web, ...credentials };
  assert.equal(googleConfig(hosted)?.callback, web + '/api/v1/auth/google/callback');
  assert.equal(googleConfig(hosted, render)?.callback, render + '/api/v1/auth/google/callback');
  assert.equal(googleConfig(hosted, render + '.example'), undefined);
  assert.equal(googleConfig(hosted, [web, render]), undefined);
  assert.equal(googleDestination('/dashboard/security?view=account#password', origin), '/dashboard/security?view=account#password');
  for (const url of ['/dashboard/../login', '/admin', '//other.example/dashboard', 'https://other.example/dashboard']) {
    assert.equal(googleDestination(url, origin), '/dashboard');
  }
});

test('Google sign-in binds the verified identity to the browser flow', async t => {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  t.after(() => {
    if (previous === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous;
  });

  const config = googleConfig({ WEB_ORIGIN: web, ...credentials }, render)!;
  const request = beginGoogle(config, 'register', '/dashboard/security');
  const flow = readGoogleFlow(request.cookie);
  assert.ok(flow);
  assert.equal(flow.origin, render);
  const url = new URL(request.url);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('redirect_uri'), render + '/api/v1/auth/google/callback');
  assert.equal(url.searchParams.get('state'), flow.state);
  assert.equal(url.searchParams.get('nonce'), flow.nonce);
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(flow.verifier).digest('base64url'));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(readGoogleFlow(request.cookie + 'invalid'), undefined);

  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyId = 'google-test-key';
  const key = { ...publicKey.export({ format: 'jwk' }), kid: keyId };
  const issue = (claims = {}, options: jwt.SignOptions = {}) => jwt.sign({
    sub: 'google-subject', nonce: flow.nonce, email: 'OWNER@gmail.com', email_verified: true, name: 'Chủ cửa hàng', ...claims,
  }, privateKey, { algorithm: 'RS256', keyid: keyId, issuer: 'https://accounts.google.com',
    audience: config.clientId, expiresIn: 60, ...options });
  let token = issue();
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    if (input === 'https://www.googleapis.com/oauth2/v3/certs') {
      return Response.json({ keys: [key] }, { headers: { 'cache-control': 'public, max-age=60' } });
    }
    assert.equal(input, 'https://oauth2.googleapis.com/token');
    assert.ok(init?.body instanceof URLSearchParams);
    assert.equal(init.body.get('code_verifier'), flow.verifier);
    assert.equal(init.body.get('redirect_uri'), config.callback);
    return Response.json({ id_token: token });
  });

  assert.deepEqual(await exchangeGoogleCode(config, flow, 'test-code'), {
    subject: 'google-subject', email: 'owner@gmail.com', name: 'Chủ cửa hàng', emailAuthoritative: true,
  });
  token = issue({ email: 'owner@example.com' });
  assert.equal((await exchangeGoogleCode(config, flow, 'test-code')).emailAuthoritative, false);
  token = issue({ email: 'owner@example.com', hd: 'example.com' });
  assert.equal((await exchangeGoogleCode(config, flow, 'test-code')).emailAuthoritative, true);
  for (const invalid of [
    issue({ nonce: randomBytes(32).toString('base64url') }),
    issue({ email_verified: false }),
    issue({}, { audience: 'another-client' }),
    issue({}, { issuer: 'https://other.example' }),
    issue({}, { expiresIn: -60 }),
  ]) {
    token = invalid;
    await assert.rejects(exchangeGoogleCode(config, flow, 'test-code'));
  }
});
