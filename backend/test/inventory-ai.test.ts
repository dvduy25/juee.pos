import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { decryptAiKey, encryptAiKey, extractInvoice, extractMenu } from '../src/services/inventory-ai';

test('the inventory API key can only be read for the business it was saved under', () => {
  process.env.AI_KEY_ENCRYPTION_SECRET = randomBytes(32).toString('hex');
  const key = 'sk-inventory-test-value';
  const a = encryptAiKey('business-a', key);
  assert.ok(!a.includes(key));
  assert.notEqual(a, encryptAiKey('business-a', key));
  assert.equal(decryptAiKey('business-a', a), key);
  assert.throws(() => decryptAiKey('business-b', a), /Không đọc được khóa AI/);
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
  const key = 'sk-test-key';
  assert.deepEqual((await extractInvoice(key, '', photo, true)).lines, invoice.lines);
  result = { ...invoice, needsRetake: true };
  await assert.rejects(extractInvoice(key, '', photo, true), /Chụp lại rõ/);
  result = { ...invoice, lines: [...invoice.lines, { name: 'Sữa', unit: null, quantity: null, unitCost: 5000, taxPercent: null }] };
  await assert.rejects(extractInvoice(key, '', photo, true), /Chụp lại rõ/);
  const menu = { needsRetake: false, lines: [{ name: 'Phở bò', price: 42000 }] };
  result = menu;
  assert.deepEqual(await extractMenu(key, photo), menu.lines);
  result = { ...menu, lines: [...menu.lines, { name: 'Cà phê', price: null }] };
  await assert.rejects(extractMenu(key, photo), /Chụp lại rõ/);
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
  assert.deepEqual(await extractInvoice('sk-test-key', '12 cái bánh mì'), { supplier: null, reference: 'PN-001', lines });
  modelText = 'invalid json';
  await assert.rejects(extractInvoice('sk-test-key', 'không đọc được'), /chưa nhận diện được/);
});
