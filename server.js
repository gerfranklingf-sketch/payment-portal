"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const BODY_LIMIT = 16 * 1024;
const INVOICES = Object.freeze({
  "INV-1042": {
    customer: "Amani Hardware Ltd",
    issued: "14 Sep 2026",
    due: "14 Oct 2026",
    items: [
      { description: "Cement, 50 kg bags x 40", amount: 42000 },
      { description: "Delivery", amount: 6000 }
    ]
  },
  "INV-1043": {
    customer: "Baraka Builders",
    issued: "21 Sep 2026",
    due: "21 Oct 2026",
    items: [
      { description: "Roofing sheets x 120", amount: 110050 },
      { description: "Fasteners, assorted", amount: 9000 },
      { description: "Delivery", amount: 6000 }
    ]
  }
});

const payments = new Map();
const paymentByInvoice = new Map();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function invoiceTotal(invoice) {
  return invoice.items.reduce((sum, item) => sum + item.amount, 0);
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^(?:254)?[17]\d{8}$/.test(digits)) {
    return digits.startsWith("254") ? digits : `254${digits}`;
  }
  return null;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new HttpError(413, "Request body is too large."));
        return;
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new Error("JSON body must be an object.");
        }
        resolve(body);
      } catch {
        reject(new HttpError(400, "Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function getConfig() {
  const config = {
    consumerKey: process.env.MPESA_CONSUMER_KEY,
    consumerSecret: process.env.MPESA_CONSUMER_SECRET,
    shortcode: process.env.MPESA_SHORTCODE || "174379",
    passkey: process.env.MPESA_PASSKEY,
    callbackUrl: process.env.MPESA_CALLBACK_URL
  };
  const missing = Object.entries(config)
    .filter(([key, value]) => key !== "shortcode" && !value)
    .map(([key]) => key);

  if (missing.length) {
    throw new HttpError(
      503,
      "M-Pesa sandbox is not configured. Set the Daraja credentials and public callback URL in .env."
    );
  }

  let callback;
  try {
    callback = new URL(config.callbackUrl);
  } catch {
    throw new HttpError(503, "MPESA_CALLBACK_URL must be a valid public HTTPS URL.");
  }
  if (callback.protocol !== "https:") {
    throw new HttpError(503, "MPESA_CALLBACK_URL must use HTTPS.");
  }
  return config;
}

function timestamp() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}${value.hour}${value.minute}${value.second}`;
}

async function darajaJson(url, options) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  } catch {
    throw new HttpError(502, "Could not connect to the M-Pesa sandbox. Please try again.");
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new HttpError(502, "The M-Pesa sandbox returned an unreadable response.");
  }
  if (!response.ok) {
    throw new HttpError(502, body.errorMessage || "The M-Pesa sandbox rejected the request.");
  }
  return body;
}

async function getAccessToken(config) {
  const credentials = Buffer.from(
    `${config.consumerKey}:${config.consumerSecret}`
  ).toString("base64");
  const body = await darajaJson(
    "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    { headers: { Authorization: `Basic ${credentials}` } }
  );
  if (!body.access_token) {
    throw new HttpError(502, "The M-Pesa sandbox did not return an access token.");
  }
  return body.access_token;
}

async function initiateStkPush(invoiceNumber, phone) {
  const config = getConfig();
  const token = await getAccessToken(config);
  const time = timestamp();
  const password = Buffer.from(
    `${config.shortcode}${config.passkey}${time}`
  ).toString("base64");
  const invoice = INVOICES[invoiceNumber];
  const payload = {
    BusinessShortCode: config.shortcode,
    Password: password,
    Timestamp: time,
    TransactionType: "CustomerPayBillOnline",
    Amount: invoiceTotal(invoice),
    PartyA: phone,
    PartyB: config.shortcode,
    PhoneNumber: phone,
    CallBackURL: config.callbackUrl,
    AccountReference: invoiceNumber,
    TransactionDesc: `Invoice ${invoiceNumber}`
  };
  const body = await darajaJson(
    "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );
  if (body.ResponseCode !== "0" || !body.CheckoutRequestID || !body.MerchantRequestID) {
    throw new HttpError(502, body.CustomerMessage || "M-Pesa could not start the payment request.");
  }
  return body;
}

function callbackMetadata(callback) {
  const items = callback.CallbackMetadata && callback.CallbackMetadata.Item;
  return Array.isArray(items)
    ? Object.fromEntries(items.map((item) => [item.Name, item.Value]))
    : {};
}

async function handleCallback(request, response) {
  const body = await readJson(request);
  const callback = body && body.Body && body.Body.stkCallback;
  if (!callback || !callback.CheckoutRequestID || !callback.MerchantRequestID) {
    throw new HttpError(400, "Invalid M-Pesa callback.");
  }

  const payment = payments.get(callback.CheckoutRequestID);
  if (!payment) {
    throw new HttpError(404, "No matching payment request was found.");
  }
  if (payment.merchantRequestId !== callback.MerchantRequestID) {
    throw new HttpError(400, "M-Pesa callback identifiers did not match.");
  }

  if (payment.status === "pending") {
    const resultCode = Number(callback.ResultCode);
    if (resultCode === 0) {
      const metadata = callbackMetadata(callback);
      if (
        Number(metadata.Amount) !== payment.amount ||
        String(metadata.PhoneNumber || "") !== payment.phone ||
        !metadata.MpesaReceiptNumber
      ) {
        payment.status = "failed";
        payment.message = "The M-Pesa confirmation did not match this payment.";
      } else {
        payment.status = "paid";
        payment.message = "Payment confirmed.";
        payment.receipt = String(metadata.MpesaReceiptNumber || "");
        paymentByInvoice.set(payment.invoiceNumber, payment.id);
      }
    } else {
      payment.status = "failed";
      payment.message = String(callback.ResultDesc || "M-Pesa payment was not completed.");
    }
    payment.updatedAt = Date.now();
    paymentByInvoice.delete(`pending:${payment.invoiceNumber}`);
  }

  sendJson(response, 200, { ResultCode: 0, ResultDesc: "Accepted" });
}

function invoiceResponse(invoiceNumber) {
  const invoice = INVOICES[invoiceNumber];
  const paymentId = paymentByInvoice.get(invoiceNumber);
  const pendingPaymentId = paymentByInvoice.get(`pending:${invoiceNumber}`);
  const paid = Boolean(paymentId);
  return {
    invoiceNumber,
    customer: invoice.customer,
    issued: invoice.issued,
    due: invoice.due,
    items: invoice.items,
    total: invoiceTotal(invoice),
    status: paid ? "paid" : pendingPaymentId ? "pending" : "due",
    pendingPaymentId: typeof pendingPaymentId === "string" ? pendingPaymentId : undefined
  };
}

function serveStatic(response, filename, contentType) {
  const filePath = path.join(__dirname, "public", filename);
  let content;
  try {
    content = fs.readFileSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") throw new HttpError(404, "Page not found.");
    throw error;
  }
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  });
  response.end(content);
}

function createServer() {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        serveStatic(response, "index.html", "text/html; charset=utf-8");
        return;
      }
      if (request.method === "GET" && url.pathname === "/app.js") {
        serveStatic(response, "app.js", "text/javascript; charset=utf-8");
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/invoices/")) {
        const invoiceNumber = decodeURIComponent(url.pathname.slice("/api/invoices/".length)).toUpperCase();
        if (!Object.hasOwn(INVOICES, invoiceNumber)) {
          throw new HttpError(404, "We could not find that invoice.");
        }
        sendJson(response, 200, { invoice: invoiceResponse(invoiceNumber) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/payments") {
        const body = await readJson(request);
        const invoiceNumber = String(body.invoiceNumber || "").trim().toUpperCase();
        const phone = normalizePhone(body.phone);
        if (!Object.hasOwn(INVOICES, invoiceNumber)) {
          throw new HttpError(404, "We could not find that invoice.");
        }
        if (!phone) {
          throw new HttpError(400, "Enter a valid Kenyan M-Pesa number.");
        }
        if (paymentByInvoice.has(invoiceNumber)) {
          throw new HttpError(409, "This invoice has already been paid.");
        }
        if (paymentByInvoice.has(`pending:${invoiceNumber}`)) {
          throw new HttpError(409, "An M-Pesa payment request is already pending for this invoice.");
        }

        paymentByInvoice.set(`pending:${invoiceNumber}`, true);
        try {
          const result = await initiateStkPush(invoiceNumber, phone);
          const id = crypto.randomUUID();
          const payment = {
            id,
            invoiceNumber,
            phone,
            amount: invoiceTotal(INVOICES[invoiceNumber]),
            checkoutRequestId: result.CheckoutRequestID,
            merchantRequestId: result.MerchantRequestID,
            status: "pending",
            message: "Check your phone and enter your M-Pesa PIN to approve the payment.",
            receipt: "",
            createdAt: Date.now()
          };
          payments.set(payment.checkoutRequestId, payment);
          paymentByInvoice.set(`pending:${invoiceNumber}`, id);
          sendJson(response, 202, {
            paymentId: id,
            status: payment.status,
            message: payment.message
          });
        } catch (error) {
          paymentByInvoice.delete(`pending:${invoiceNumber}`);
          throw error;
        }
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/payments/")) {
        const id = url.pathname.slice("/api/payments/".length);
        const payment = [...payments.values()].find((item) => item.id === id);
        if (!payment) throw new HttpError(404, "Payment request not found.");
        sendJson(response, 200, {
          paymentId: payment.id,
          invoiceNumber: payment.invoiceNumber,
          status: payment.status,
          message: payment.message,
          receipt: payment.receipt
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/mpesa/callback") {
        await handleCallback(request, response);
        return;
      }
      throw new HttpError(404, "Not found.");
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) console.error(error);
      sendJson(response, status, {
        error: status === 500 ? "An unexpected server error occurred." : error.message
      });
    }
  });
}

if (require.main === module) {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  createServer().listen(PORT, "127.0.0.1", () => {
    console.log(`M-Pesa sandbox checkout listening at http://127.0.0.1:${PORT}`);
  });
}

module.exports = { createServer, normalizePhone, invoiceTotal, INVOICES };
