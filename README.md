# nodemailer-duva

[Nodemailer](https://nodemailer.com) transport for [Duva](https://duva.ca), the transactional email API hosted in Canada.
Keep using `sendMail()`; the messages go out through Duva.

Requires Node.js 22+ and Nodemailer 6.9+. Built on the official [`duva-mail`](https://www.npmjs.com/package/duva-mail)
library. ESM and CommonJS.

```bash
npm install nodemailer-duva nodemailer
```

You also need a Duva API key and a verified domain ([documentation](https://duva.ca/en/docs)).

## Use

```js
import nodemailer from "nodemailer";
import { duvaTransport } from "nodemailer-duva";

const transporter = nodemailer.createTransport(
  duvaTransport({ apiKey: process.env.DUVA_API_KEY, domain: "example.com" }),
);

const info = await transporter.sendMail({
  from: "Example <notifications@example.com>", // the address must belong to the Duva domain
  to: "client@example.org",
  subject: "Your order",
  text: "Thank you for your order.",
  html: "<p>Thank you for your order.</p>",
});

console.log(info.messageId, info.response); // Duva's message id, "queued"
```

`apiKey` and `domain` default to the `DUVA_API_KEY` and `DUVA_DOMAIN` environment variables. The other options are those of
the `duva-mail` client: `baseUrl`, `timeout`, `maxRetries`, `language`, `userAgent`, `fetch`.

## What is sent

| Nodemailer | Duva |
|---|---|
| `from`, `to`, `cc`, `bcc`, `replyTo` (and an address only in `envelope`, sent as Bcc) | `from`, `to`, `cc`, `bcc`, `reply_to` |
| `text`, `html` (string, Buffer or stream) | `text`, `html` |
| `attachments` (`content` as string, Buffer or stream; `path` to a local file; `cid` for inline images) | `attachments` |
| `list.unsubscribe`; `List-Unsubscribe`, `List-Unsubscribe-Post`, `List-Id`, `In-Reply-To`, `References`, `Auto-Submitted`, `Precedence`, `Importance`, `Feedback-ID` and `X-*` in `headers` | `headers` |
| `duva: { tags, metadata, tracking, idempotencyKey }` | `tags`, `metadata`, `tracking`, `Idempotency-Key` |

```js
await transporter.sendMail({
  /* ... */
  duva: {
    tags: ["welcome"],
    metadata: { order_id: "42" },
    tracking: { opens: true, clicks: true }, // needs an HTML body
    idempotencyKey: "order-42", // a second send with this key never creates a second message
  },
});
```

Notes:

- Other headers are not forwarded (Duva rejects them), nor are `X-Duva*`, `X-Kumo*`, `X-Tenant*` and `X-Campaign*`.
- A display name Duva refuses (it contains `@`, quotes, `<>`, control characters or an encoded word `=?…?=`) is dropped;
  the address is kept.
- Not supported, with a clear error before any request: `raw` messages, and remote attachments (`href`, or a `path` that is
  a URL): give the content or a local path.
- Delivery is asynchronous: `sendMail()` resolving means Duva accepted the message (`queued`), not that it was delivered.
  Use Duva's webhooks or events for the outcome.
- A Duva error rejects `sendMail()` with the `duva-mail` error (`ValidationError`, `RateLimitError`...), with its `code`.
- Every recipient of a message sees the other `to` and `cc` recipients. Use `bcc`, or one message per recipient.

## TypeScript

The `duva` option is added to Nodemailer's message options by this package's types. `sendMail()` resolves to a
`DuvaSentInfo` (`messageId`, `accepted`, `response`, and `duva`, Duva's full answer); cast it if you need the type.

## Testing your application

Pass `fetch` to keep the network out of your tests:

```js
const transporter = nodemailer.createTransport(
  duvaTransport({ apiKey: "dv_test", domain: "example.com", fetch: myFakeFetch }),
);
```

## License

MIT.
