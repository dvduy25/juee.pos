import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { BadGatewayException, GatewayTimeoutException, ServiceUnavailableException } from '@nestjs/common';
import { decryptAiKey, encryptAiKey, extractInvoice, extractMenu } from '../src/services/inventory-ai';

test('the inventory API key can only be read for the business it was saved under', () => {
  process.env.AI_KEY_ENCRYPTION_SECRET = randomBytes(32).toString('hex');
  const key = 'sk-inventory-test-value';
  const a = encryptAiKey('business-a', key);
  assert.ok(!a.includes(key));
  assert.notEqual(a, encryptAiKey('business-a', key));
  assert.equal(decryptAiKey('business-a', a), key);
  assert.throws(() => decryptAiKey('business-b', a), /Không đọc được khóa AI/);
  const gemini = encryptAiKey('business-a', 'gemini-key', 'gemini');
  assert.equal(decryptAiKey('business-a', gemini, 'gemini'), 'gemini-key');
  assert.throws(() => decryptAiKey('business-a', gemini, 'openai'), /Không đọc được khóa AI/);
});

test('photo extraction rejects incomplete invoices and menus before they reach review', async t => {
  const invoice = {
    supplier: 'Công ty ABC', reference: null, needsRetake: false,
    lines: [{ name: 'Gạo', unit: 'kg', quantity: 2.5, unitCost: 23000, taxPercent: null }],
  };
  const photo = { bytes: Buffer.from('mock-photo'), contentType: 'image/jpeg' };
  let result: object = invoice;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.input[0].content[1].detail, 'high');
    assert.ok(payload.text.format.schema.required.includes('needsRetake'));
    return Response.json({ output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }] });
  });
  const credentials = { provider: 'openai', key: 'sk-test-key' } as const;
  assert.deepEqual((await extractInvoice(credentials, { image: photo, purchasePhoto: true })).lines, invoice.lines);
  result = { ...invoice, needsRetake: true };
  await assert.rejects(extractInvoice(credentials, { image: photo, purchasePhoto: true }), /Chụp lại rõ/);
  result = { ...invoice, lines: [...invoice.lines, { name: 'Sữa', unit: null, quantity: null, unitCost: 5000, taxPercent: null }] };
  await assert.rejects(extractInvoice(credentials, { image: photo, purchasePhoto: true }), /Chụp lại rõ/);
  const menu = { needsRetake: false, lines: [{ name: 'Phở bò', price: 42000 }] };
  result = menu;
  assert.deepEqual(await extractMenu(credentials, photo), menu.lines);
  result = { ...menu, lines: [...menu.lines, { name: 'Cà phê', price: null }] };
  await assert.rejects(extractMenu(credentials, photo), /Chụp lại rõ/);
});

test('the invoice parser requests a bounded draft and ignores invalid model responses', async t => {
  const lines = [{ name: 'Bánh mì', unit: 'cái', quantity: 12, unitCost: null, taxPercent: null }];
  let modelText = JSON.stringify({ supplier: null, reference: 'PN-001', lines });
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer sk-test-key');
    assert.equal(init.redirect, 'error');
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.store, false);
    assert.equal(payload.text.format.strict, true);
    return Response.json({ output: [{ content: [{ type: 'output_text', text: modelText }] }] });
  });
  assert.deepEqual(await extractInvoice({ provider: 'openai', key: 'sk-test-key' }, { text: '12 cái bánh mì' }), { supplier: null, reference: 'PN-001', lines });
  modelText = 'invalid json';
  await assert.rejects(extractInvoice({ provider: 'openai', key: 'sk-test-key' }, { text: 'không đọc được' }), /chưa nhận diện được/);
});

test('Gemini reads text, invoice photos, menu photos and recordings as validated drafts', async t => {
  const credentials = { provider: 'gemini', key: 'AQ.fake_test_key_for_inventory_request_123456789012' } as const;
  type RequestData = { contents: { parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] }[];
    generationConfig: { responseMimeType: string; responseJsonSchema: { required: string[] } } };
  let request: RequestData | undefined;
  let finishReason = 'STOP';
  let status = 200;
  const invoice = { supplier: 'Kho ABC', reference: null, lines: [{ name: 'Gạo', unit: 'kg', quantity: 2, unitCost: 10000, taxPercent: null }] };
  let output: object = invoice;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
    assert.equal((init.headers as Record<string, string>)['x-goog-api-key'], credentials.key);
    assert.equal(init.redirect, 'error');
    request = JSON.parse(String(init.body)) as RequestData;
    assert.equal(request.generationConfig.responseMimeType, 'application/json');
    if (status !== 200) return Response.json(output, { status });
    return Response.json({ candidates: [{ finishReason, content: { parts: [
      { thought: true, text: 'deliberation' }, { text: JSON.stringify(output) },
    ] } }] });
  });
  assert.deepEqual(await extractInvoice(credentials, { text: '2 kg gạo' }), invoice);
  assert.deepEqual(request?.contents[0].parts, [{ text: '2 kg gạo' }]);

  const photo = { bytes: Buffer.from('photo'), contentType: 'image/jpeg' };
  output = { ...invoice, needsRetake: false };
  assert.deepEqual(await extractInvoice(credentials, { image: photo, purchasePhoto: true }), invoice);
  assert.ok(request?.generationConfig.responseJsonSchema.required.includes('needsRetake'));
  assert.deepEqual(request?.contents[0].parts[1].inlineData, { mimeType: 'image/jpeg', data: photo.bytes.toString('base64') });
  output = { ...invoice, needsRetake: true };
  await assert.rejects(extractInvoice(credentials, { image: photo, purchasePhoto: true }), /Chụp lại rõ/);

  const menu = [{ name: 'Phở', price: 30000 }];
  output = { lines: menu, needsRetake: false };
  assert.deepEqual(await extractMenu(credentials, photo), menu);
  finishReason = 'MAX_TOKENS';
  await assert.rejects(extractMenu(credentials, photo), /Chụp lại rõ/);

  finishReason = 'STOP';
  output = invoice;
  const audio = { buffer: Buffer.from('audio'), mimetype: 'audio/mp4;codecs=mp4a' };
  assert.deepEqual(await extractInvoice(credentials, { audio }), invoice);
  assert.deepEqual(request?.contents[0].parts[1].inlineData, { mimeType: 'audio/m4a', data: audio.buffer.toString('base64') });

  status = 400;
  output = { error: { details: [{ reason: 'API_KEY_INVALID' }] } };
  await assert.rejects(extractInvoice(credentials, { text: 'test' }), /Gemini từ chối khóa API/);
  status = 429;
  output = { error: { status: 'RESOURCE_EXHAUSTED' } };
  await assert.rejects(extractInvoice(credentials, { text: 'test' }), /hết hạn mức/);

  status = 400;
  output = { error: { status: 'INVALID_ARGUMENT', message: 'private provider payload' } };
  await assert.rejects(extractInvoice(credentials, { text: 'test' }), error => {
    assert.ok(error instanceof BadGatewayException);
    assert.deepEqual(error.getResponse(), { code: 'INVENTORY_AI_UPSTREAM',
      message: 'Gemini không chấp nhận yêu cầu đọc chứng từ (HTTP 400). Hãy thử nhập nội dung ngắn để kiểm tra kết nối.' });
    return true;
  });
});

test('Gemini times out while reading a response without treating the document as unreadable', async t => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  const response = Response.json({});
  t.mock.method(response, 'json', async () => {
    controller.abort();
    throw new Error('Aborted');
  });
  t.mock.method(globalThis, 'fetch', async () => response);
  await assert.rejects(extractInvoice({ provider: 'gemini', key: 'fake-key' }, { text: 'test' }), error => {
    assert.ok(error instanceof GatewayTimeoutException);
    assert.deepEqual(error.getResponse(), { code: 'INVENTORY_AI_UPSTREAM',
      message: 'Gemini phản hồi quá lâu. Hãy thử lại với ảnh nhỏ hơn hoặc nội dung ngắn hơn.' });
    return true;
  });
});

test('Gemini retries a temporary 503 with the same photo and within one deadline', async t => {
  const credentials = { provider: 'gemini', key: 'fake-key' } as const;
  const image = { bytes: Buffer.from('photo'), contentType: 'image/jpeg' };
  const menu = [{ name: 'Trà đào', price: 30000 }];
  const attempts: RequestInit[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    attempts.push(init);
    if (attempts.length < 3) return Response.json({}, { status: 503 });
    return Response.json({ candidates: [{ finishReason: 'STOP', content: {
      parts: [{ text: JSON.stringify({ needsRetake: false, lines: menu }) }],
    } }] });
  });
  assert.deepEqual(await extractMenu(credentials, image), menu);
  assert.equal(attempts.length, 3);
  for (const attempt of attempts) {
    assert.equal(attempt.body, attempts[0].body);
    assert.equal(attempt.signal, attempts[0].signal);
  }
});

test('Gemini stops after two retries or when the upstream explicitly asks for a long delay', async t => {
  const credentials = { provider: 'gemini', key: 'fake-key' } as const;
  let calls = 0;
  let retryAfter = '120';
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({}, { status: 503, headers: { 'Retry-After': retryAfter } });
  });
  const error = (cause: unknown) => cause instanceof ServiceUnavailableException && /Gemini đang bận/.test(cause.message);
  await assert.rejects(extractInvoice(credentials, { text: 'test' }), error);
  assert.equal(calls, 1);
  retryAfter = '0';
  calls = 0;
  await assert.rejects(extractInvoice(credentials, { text: 'test' }), error);
  assert.equal(calls, 3);
});
