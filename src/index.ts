import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import {
  Attachment,
  Duva,
  formatAddress,
  type ClientOptions,
  type SendMessageInput,
  type SendMessageResult,
} from "duva-mail";
import type { Transport } from "nodemailer";
import type MailMessage from "nodemailer/lib/mailer/mail-message.js";

/** Duva options for ONE message: `transporter.sendMail({ ..., duva: { tags: ["welcome"] } })`. */
export interface DuvaMessageOptions {
  tags?: string[];
  /** Never sent to the recipient; returned with the message, its events and webhooks. */
  metadata?: Record<string, string>;
  tracking?: { opens?: boolean; clicks?: boolean };
  /** A stable key (an order id, for example): a second send with the same key never creates a second message. */
  idempotencyKey?: string;
}

declare module "nodemailer/lib/mailer/index.js" {
  interface Options {
    duva?: DuvaMessageOptions;
  }
}

export interface DuvaTransportOptions extends ClientOptions {
  /** An already built client (tests, or to share one). Replaces the other options. */
  client?: Duva;
}

/** What `sendMail()` resolves to. `messageId` is Duva's message id. */
export interface DuvaSentInfo {
  messageId: string;
  envelope: { from: string | false; to: string[] };
  accepted: string[];
  rejected: string[];
  pending: string[];
  response: string;
  duva: SendMessageResult;
}

// Duva's `headers` allowlist (docs/api.md); every other `X-*` is allowed except the reserved prefixes.
const ALLOWED_HEADERS = new Set([
  "list-unsubscribe", "list-unsubscribe-post", "list-id", "in-reply-to", "references",
  "auto-submitted", "precedence", "importance", "feedback-id",
]); // fmt: skip
const RESERVED_PREFIXES = ["x-kumo", "x-duva", "x-tenant", "x-campaign"];
// A name Duva refuses: `@`, quotes, angle brackets, backslash, control characters, encoded words.
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME = /[@"<>\\\u0000-\u001f\u007f]|=\?/;

interface Address {
  name?: string;
  address: string;
}

/**
 * A Nodemailer transport that sends through the Duva API.
 *
 * ```js
 * const transporter = nodemailer.createTransport(duvaTransport({ apiKey: "dv_...", domain: "example.com" }));
 * await transporter.sendMail({ from: "Shop <shop@example.com>", to: "client@example.org", subject: "Hi", text: "Hello" });
 * ```
 */
export function duvaTransport(options: DuvaTransportOptions = {}): Transport<DuvaSentInfo> {
  const { client: given, ...clientOptions } = options;
  const client = given ?? new Duva(clientOptions);

  return {
    name: "duva",
    version: "0.1.0",
    send(mail, callback) {
      deliver(client, mail as MailMessage).then(
        (info) => callback(null, info),
        (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), undefined as never),
      );
    },
  };
}

async function deliver(client: Duva, mail: MailMessage): Promise<DuvaSentInfo> {
  const data = mail.data as Record<string, any>;
  if (data.raw) throw new TypeError("Duva: the `raw` option is not supported; give text, html and attachments");

  const addresses = mail.message.getAddresses() as Record<string, Address[] | undefined>;
  const from = addresses.from?.[0];
  if (!from) throw new TypeError("Duva: the message has no From address");
  const to = addresses.to ?? [];
  const cc = addresses.cc ?? [];
  const bcc = [...(addresses.bcc ?? [])];

  // A recipient only in the envelope (an explicit `envelope` option) is a blind copy.
  const envelope = mail.message.getEnvelope() as { from: string | false; to: string[] };
  const known = new Set([...to, ...cc, ...bcc].map((a) => a.address.toLowerCase()));
  for (const address of envelope.to) {
    if (!known.has(address.toLowerCase())) {
      bcc.push({ address });
      known.add(address.toLowerCase());
    }
  }

  const duva = (data.duva ?? {}) as DuvaMessageOptions;
  const input: SendMessageInput = {
    from: format(from),
    to: to.map(format),
    subject: String(data.subject ?? ""),
  };
  if (cc.length) input.cc = cc.map(format);
  if (bcc.length) input.bcc = bcc.map(format);
  const html = await text(data.html);
  const plain = await text(data.text);
  if (html !== undefined) input.html = html;
  if (plain !== undefined) input.text = plain;
  const replyTo = addresses["reply-to"]?.[0];
  if (replyTo) input.replyTo = format(replyTo);

  const headers = forwardedHeaders(data);
  if (Object.keys(headers).length) input.headers = headers;
  if (duva.tags?.length) input.tags = duva.tags;
  if (duva.metadata && Object.keys(duva.metadata).length) input.metadata = duva.metadata;
  if (duva.tracking) input.tracking = duva.tracking;
  if (duva.idempotencyKey) input.idempotencyKey = duva.idempotencyKey;
  const attachments = await Promise.all(((data.attachments ?? []) as Record<string, any>[]).map(toAttachment));
  if (attachments.length) input.attachments = attachments;

  const result = await client.messages.send(input);
  const recipients = [...to, ...cc, ...bcc].map((a) => a.address);
  return {
    messageId: result.id,
    envelope,
    accepted: recipients,
    rejected: [],
    pending: [],
    response: result.status,
    duva: result,
  };
}

/** `Name <address>`, or the bare address when Duva would refuse the name. */
function format(address: Address): string {
  const name = address.name ?? "";
  return name === "" || UNSAFE_NAME.test(name) ? address.address : formatAddress(address.address, name);
}

function forwardedHeaders(data: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  const entries: [string, unknown][] = Array.isArray(data.headers)
    ? (data.headers as { key: string; value: unknown }[]).map((h) => [h.key, h.value])
    : Object.entries((data.headers ?? {}) as Record<string, unknown>);
  for (const [key, raw] of entries) {
    const value = headerValue(raw);
    if (value !== undefined && forwardable(key.toLowerCase())) out[key] = value;
  }
  const unsubscribe = listUnsubscribe(data.list?.unsubscribe);
  if (unsubscribe && out["List-Unsubscribe"] === undefined) out["List-Unsubscribe"] = unsubscribe;
  return out;
}

function headerValue(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map(String).join(", ");
  if (raw && typeof raw === "object" && "value" in raw) return String((raw as { value: unknown }).value);
  return raw === undefined || raw === null ? undefined : String(raw);
}

function forwardable(lowerName: string): boolean {
  if (ALLOWED_HEADERS.has(lowerName)) return true;
  return lowerName.startsWith("x-") && !RESERVED_PREFIXES.some((prefix) => lowerName.startsWith(prefix));
}

/** Nodemailer's `list.unsubscribe` (a url, an email address, `{ url, comment }`, or an array of those). */
function listUnsubscribe(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const links = (Array.isArray(value) ? value : [value]).map((item) => {
    const url = String(typeof item === "object" && item !== null ? (item as { url: unknown }).url : item);
    return `<${/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `mailto:${url}`}>`;
  });
  return links.join(", ");
}

async function text(value: unknown): Promise<string | undefined> {
  if (value === undefined || value === null) return undefined;
  const buffer = await bytes(value, "html/text content");
  const string = buffer.toString("utf8");
  return string === "" ? undefined : string;
}

async function toAttachment(item: Record<string, any>): Promise<Attachment> {
  if (item.href) throw new TypeError("Duva: remote attachments (`href`) are not fetched; give `content` or a local `path`");
  const source = item.content ?? (item.path ? { path: item.path } : undefined);
  if (source === undefined) throw new TypeError(`Duva: attachment ${item.filename ?? ""} has no content or path`);
  let buffer = await bytes(source, "attachment");
  if (typeof item.content === "string" && item.encoding && item.encoding !== "utf8") {
    buffer = Buffer.from(item.content, item.encoding as BufferEncoding);
  }
  const filename = item.filename ?? (item.path ? basename(String(item.path)) : "attachment");
  const options: { contentType?: string; contentId?: string } = {};
  if (item.contentType) options.contentType = String(item.contentType);
  if (item.cid) options.contentId = String(item.cid);
  return Attachment.fromBytes(String(filename), buffer, options);
}

/** A string, Buffer, stream, or `{ path }` (a local file; a remote `href` is refused on purpose). */
async function bytes(value: unknown, what: string): Promise<Buffer> {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of value) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  }
  if (value && typeof value === "object") {
    const holder = value as { path?: unknown; content?: unknown };
    if (typeof holder.path === "string") {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(holder.path)) {
        throw new TypeError(`Duva: a remote ${what} is not fetched; give the content or a local path`);
      }
      return readFile(holder.path);
    }
    if (holder.content !== undefined) return bytes(holder.content, what);
  }
  throw new TypeError(`Duva: unsupported ${what}`);
}

export { Duva };
export type { ClientOptions, SendMessageResult };
