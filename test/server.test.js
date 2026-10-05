"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { createServer, normalizePhone, invoiceTotal, INVOICES } = require("../server");

let server;
let baseUrl;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("normalizes valid Kenyan M-Pesa phone number formats", () => {
  assert.equal(normalizePhone("0712 345 678"), "254712345678");
  assert.equal(normalizePhone("+254 712 345 678"), "254712345678");
  assert.equal(normalizePhone("212345678"), null);
});

test("invoice totals are integer Kenyan shillings", () => {
  assert.equal(invoiceTotal(INVOICES["INV-1042"]), 48000);
  assert.equal(invoiceTotal(INVOICES["INV-1043"]), 125050);
});

test("returns the server-owned invoice amount", async () => {
  const response = await fetch(`${baseUrl}/api/invoices/INV-1042`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.invoice.total, 48000);
  assert.equal(body.invoice.status, "due");
});

test("returns not found for an unknown invoice", async () => {
  const response = await fetch(`${baseUrl}/api/invoices/INV-9999`);
  assert.equal(response.status, 404);
});

test("rejects invalid phone numbers without contacting Daraja", async () => {
  const response = await fetch(`${baseUrl}/api/payments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invoiceNumber: "INV-1042", phone: "not a phone" })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /valid Kenyan M-Pesa number/);
});

test("serves the checkout application with security headers", async () => {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(await response.text(), /M-Pesa sandbox checkout/);
});

test("starts a sandbox STK Push and marks the invoice paid only on a matching callback", async () => {
  const originalFetch = globalThis.fetch;
  const names = [
    "MPESA_CONSUMER_KEY",
    "MPESA_CONSUMER_SECRET",
    "MPESA_SHORTCODE",
    "MPESA_PASSKEY",
    "MPESA_CALLBACK_URL"
  ];
  const originalEnv = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  let stkPayload;

  for (const name of names) delete process.env[name];
  process.env.MPESA_CONSUMER_KEY = "test-key";
  process.env.MPESA_CONSUMER_SECRET = "test-secret";
  process.env.MPESA_SHORTCODE = "174379";
  process.env.MPESA_PASSKEY = "test-passkey";
  process.env.MPESA_CALLBACK_URL = "https://callback.example.test/api/mpesa/callback";
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.origin === baseUrl) return originalFetch(input, options);
    if (url.pathname.endsWith("/oauth/v1/generate")) {
      return Response.json({ access_token: "test-token" });
    }
    if (url.pathname.endsWith("/stkpush/v1/processrequest")) {
      stkPayload = JSON.parse(options.body);
      return Response.json({
        ResponseCode: "0",
        MerchantRequestID: "merchant-test-1",
        CheckoutRequestID: "checkout-test-1"
      });
    }
    throw new Error(`Unexpected mocked Daraja URL: ${url}`);
  };

  try {
    const start = await originalFetch(`${baseUrl}/api/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoiceNumber: "INV-1042", phone: "0712 345 678" })
    });
    assert.equal(start.status, 202);
    const started = await start.json();
    assert.equal(stkPayload.Amount, 48000);
    assert.equal(stkPayload.PhoneNumber, "254712345678");

    const callback = await originalFetch(`${baseUrl}/api/mpesa/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Body: {
          stkCallback: {
            MerchantRequestID: "merchant-test-1",
            CheckoutRequestID: "checkout-test-1",
            ResultCode: 0,
            ResultDesc: "Success",
            CallbackMetadata: {
              Item: [
                { Name: "Amount", Value: 48000 },
                { Name: "MpesaReceiptNumber", Value: "RCP123" },
                { Name: "PhoneNumber", Value: 254712345678 }
              ]
            }
          }
        }
      })
    });
    assert.equal(callback.status, 200);

    const statusResponse = await originalFetch(`${baseUrl}/api/payments/${started.paymentId}`);
    assert.deepEqual(await statusResponse.json(), {
      paymentId: started.paymentId,
      invoiceNumber: "INV-1042",
      status: "paid",
      message: "Payment confirmed.",
      receipt: "RCP123"
    });
    const invoiceResponse = await originalFetch(`${baseUrl}/api/invoices/INV-1042`);
    assert.equal((await invoiceResponse.json()).invoice.status, "paid");
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  }
});
