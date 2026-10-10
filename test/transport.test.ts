import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import nodemailer from "nodemailer";
import { describe, expect, it } from "vitest";
import { duvaTransport, type DuvaSentInfo } from "../src/index.js";

const ID = `msg_${"0".repeat(31)}1`;

function setup(respond?: (request: Request) => Response | Promise<Response>) {
  const requests: { url: string; headers: Headers; body: any }[] = [];
  const fakeFetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, headers: request.headers, body: JSON.parse(await request.clone().text()) });
    return (
      (await respond?.(request)) ??
      new Response(JSON.stringify({ id: ID, status: "queued" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      })
    );
  }) as typeof fetch;
  const transporter = nodemailer.createTransport(
    duvaTransport({ apiKey: "dv_test", domain: "example.com", fetch: fakeFetch, maxRetries: 0 }),
  );
  return { transporter, requests };
}

describe("duvaTransport", () => {
  it("maps a message to the Duva request and resolves with Duva's id", async () => {
    const { transporter, requests } = setup();

    const info = (await transporter.sendMail({
      from: "Shop <shop@example.com>",
      to: ["Client <a@example.org>", "b@example.org"],
      cc: "Cc Person <cc@example.org>",
      bcc: "hidden@example.org",
      replyTo: "Support <help@example.com>",
      subject: "Order",
      text: "Plain",
      html: "<p>Hi</p>",
    })) as DuvaSentInfo;

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.duva.ca/v1/example.com/messages");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer dv_test");
    expect(requests[0]!.body).toEqual({
      from: "Shop <shop@example.com>",
      to: ["Client <a@example.org>", "b@example.org"],
      cc: ["Cc Person <cc@example.org>"],
      bcc: ["hidden@example.org"],
      subject: "Order",
      html: "<p>Hi</p>",
      text: "Plain",
      reply_to: "Support <help@example.com>",
    });
    expect(info.messageId).toBe(ID);
    expect(info.accepted).toEqual(["a@example.org", "b@example.org", "cc@example.org", "hidden@example.org"]);
    expect(info.response).toBe("queued");
    expect(info.duva.id).toBe(ID);
  });

  it("drops a display name Duva would refuse but keeps the address", async () => {
    const { transporter, requests } = setup();

    await transporter.sendMail({
      from: "shop@example.com",
      to: [{ name: "Mallory @ evil.com", address: "a@example.org" }, { name: "Foo", address: "b@example.org" }],
      cc: { name: "=?UTF-8?B?Zm9v?=", address: "c@example.org" },
      subject: "S",
      text: "x",
    });

    expect(requests[0]!.body.to).toEqual(["a@example.org", "Foo <b@example.org>"]);
    expect(requests[0]!.body.cc).toEqual(["c@example.org"]);
  });

  it("treats an envelope-only recipient as a blind copy", async () => {
    const { transporter, requests } = setup();

    await transporter.sendMail({
      from: "shop@example.com",
      to: "a@example.org",
      subject: "S",
      text: "x",
      envelope: { from: "shop@example.com", to: ["a@example.org", "audit@example.com"] },
    });

    expect(requests[0]!.body.bcc).toEqual(["audit@example.com"]);
  });

  it("forwards tags, metadata, tracking, the idempotency key and allowed headers only", async () => {
    const { transporter, requests } = setup();

    await transporter.sendMail({
      from: "shop@example.com",
      to: "a@example.org",
      subject: "S",
      html: "<p>x</p>",
      headers: {
        "List-Unsubscribe": "<https://example.com/u/1>",
        "X-Custom": "yes",
        "X-Duva-Secret": "no",
        "X-Kumo-Route": "no",
        Organization: "Acme",
      },
      duva: {
        tags: ["welcome"],
        metadata: { order_id: "42" },
        tracking: { opens: true },
        idempotencyKey: "order-42",
      },
    });

    const [{ body, headers }] = requests as [(typeof requests)[number]];
    expect(body.tags).toEqual(["welcome"]);
    expect(body.metadata).toEqual({ order_id: "42" });
    expect(body.tracking).toEqual({ opens: true, clicks: false });
    expect(body.headers).toEqual({ "List-Unsubscribe": "<https://example.com/u/1>", "X-Custom": "yes" });
    expect(headers.get("idempotency-key")).toBe("order-42");
  });

  it("builds List-Unsubscribe from Nodemailer's list option", async () => {
    const { transporter, requests } = setup();

    await transporter.sendMail({
      from: "shop@example.com",
      to: "a@example.org",
      subject: "S",
      text: "x",
      list: { unsubscribe: ["https://example.com/u/1", { url: "unsub@example.com", comment: "email" }] },
    });

    expect(requests[0]!.body.headers).toEqual({
      "List-Unsubscribe": "<https://example.com/u/1>, <mailto:unsub@example.com>",
    });
  });

  it("sends attachments from content, streams, files and inline images", async () => {
    const { transporter, requests } = setup();
    const dir = await mkdtemp(join(tmpdir(), "duva-"));
    await writeFile(join(dir, "report.txt"), "from disk");

    await transporter.sendMail({
      from: "shop@example.com",
      to: "a@example.org",
      subject: "S",
      html: '<img src="cid:logo">',
      attachments: [
        { filename: "note.txt", content: "hello", contentType: "text/plain" },
        { filename: "stream.txt", content: Readable.from(["str", "eam"]) },
        { path: join(dir, "report.txt") },
        { filename: "logo.png", content: Buffer.from("PNG"), cid: "logo", contentType: "image/png" },
        { filename: "b64.txt", content: Buffer.from("decoded").toString("base64"), encoding: "base64" },
      ],
    });

    const byName = Object.fromEntries(requests[0]!.body.attachments.map((a: any) => [a.filename, a]));
    const decode = (name: string) => Buffer.from(byName[name].content, "base64").toString();
    expect(decode("note.txt")).toBe("hello");
    expect(byName["note.txt"].content_type).toBe("text/plain");
    expect(byName["note.txt"].content_id).toBeNull();
    expect(decode("stream.txt")).toBe("stream");
    expect(decode("report.txt")).toBe("from disk");
    expect(byName["logo.png"].content_id).toBe("logo");
    expect(decode("b64.txt")).toBe("decoded");
  });

  it("refuses what Duva cannot do, before any request", async () => {
    const { transporter, requests } = setup();
    const base = { from: "shop@example.com", to: "a@example.org", subject: "S", text: "x" };

    await expect(transporter.sendMail({ ...base, raw: "From: x\r\n\r\nbody" })).rejects.toThrow(/raw/);
    await expect(
      transporter.sendMail({ ...base, attachments: [{ filename: "a.txt", href: "https://example.com/a.txt" } as never] }),
    ).rejects.toThrow(/remote attachments/);
    await expect(
      transporter.sendMail({ ...base, attachments: [{ filename: "a.txt", path: "https://example.com/a.txt" }] }),
    ).rejects.toThrow(/remote/);
    await expect(
      transporter.sendMail({ ...base, attachments: [{ filename: "run.exe", content: "x" }] }),
    ).rejects.toThrow(/executable/);
    expect(requests).toHaveLength(0);
  });

  it("rejects with the Duva error, so a failover or a catch can react to it", async () => {
    const { transporter } = setup(
      () =>
        new Response(JSON.stringify({ error: { code: "invalid_request", message: "Invalid message" } }), {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      transporter.sendMail({ from: "shop@example.com", to: "a@example.org", subject: "S", text: "x" }),
    ).rejects.toMatchObject({ name: "ValidationError", code: "invalid_request" });
  });

  it("fails fast without an API key", () => {
    const saved = process.env.DUVA_API_KEY;
    delete process.env.DUVA_API_KEY;
    try {
      expect(() => duvaTransport({ domain: "example.com" })).toThrow(/API key/);
    } finally {
      if (saved !== undefined) process.env.DUVA_API_KEY = saved;
    }
  });
});
