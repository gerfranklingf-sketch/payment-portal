# Meridian M-Pesa checkout demo

A small Node.js application that looks up the sample invoices and starts a Safaricom Daraja **sandbox** STK Push. The server, not the browser, chooses the amount and marks an invoice paid only after a matching successful Daraja callback.

## Requirements

- Node.js 20.6 or newer
- Safaricom Daraja sandbox app credentials
- A publicly reachable HTTPS callback URL that forwards `POST /api/mpesa/callback` to this server (for example, through a secure development tunnel)

## Run locally

1. Copy `.env.example` to `.env`.
2. Set `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_PASSKEY`, and `MPESA_CALLBACK_URL` using the values from your Daraja **sandbox** app. Do not commit `.env` or share these credentials.
3. Run `npm start` and open <http://127.0.0.1:3000>.
4. Look up `INV-1042` or `INV-1043`, enter a Kenyan M-Pesa number, and approve the sandbox prompt.

The callback URL must be HTTPS and reachable by Safaricom; `localhost` is not reachable from Daraja. The sandbox shortcode defaults to `174379` and can be overridden with `MPESA_SHORTCODE`.

## Verify

Run `npm test` to run the built-in Node.js tests.

## Demo limitations

This is a sandbox integration, not a production payment service. Sample invoices and payment state are held in memory, so they reset when the server restarts. Production use needs durable storage and transaction/idempotency controls, deployment-specific callback verification and monitoring, and production Daraja credentials and configuration. The page does not collect or store card details.
