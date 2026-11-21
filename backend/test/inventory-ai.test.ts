import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { decryptAiKey, encryptAiKey, extractInvoice } from '../src/services/inventory-ai';

test('the inventory API key can only be read for the business it was saved under', () => {
  process.env.AI_KEY_ENCRYPTION_SECRET = randomBytes(32).toString('hex');
  const key = 'sk-inventory-test-value';
  const a = encryptAiKey('business-a', key);
  assert.ok(!a.includes(key));
  assert.notEqual(a, encryptAiKey('business-a', key));
  assert.equal(decryptAiKey('business-a', a), key);
  assert.throws(() => decryptAiKey('business-b', a), /Không đọc được khóa AI/);
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
