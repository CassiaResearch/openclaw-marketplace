import { experimental_createTool } from "@composio/core";
// zod 3.25+ ships both v3 and v4 under subpaths; the default export is v4.
// experimental_createTool validates inputParams as a v3 ZodObject — using
// `zod` directly fails because the v4 instance fails Composio's v3 instanceof
// check. Always import from `zod/v3` for custom tool schemas.
import { z } from "zod/v3";

type ProxyResponse = {
  status?: number;
  headers?: Record<string, string>;
  data?: unknown;
};

type ProxyExecuteRequest = {
  toolkit: string;
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  body?: unknown;
  queryParams?: Record<string, string>;
  headers?: Record<string, string>;
};

type ProxyCtx = {
  proxyExecute: (req: ProxyExecuteRequest) => Promise<ProxyResponse>;
};

const debug = process.env.COMPOSIO_PLUS_DEBUG
  ? (m: string) => console.error(m)
  : () => {};

export const replyTool = experimental_createTool("REPLY_TO_EMAIL", {
  name: "Reply to email (Instantly)",
  description: [
    "Send an approved reply on an Instantly email thread, using the exact",
    "sender mailbox (eaccount) that sent the original outbound. Use only",
    "after the operator approves the draft; never invent or edit content.",
    "",
    "Pick this tool when the user asks to send / fire / respond with an",
    "approved Instantly draft. Do not use for Gmail or other channels.",
    "",
    "Returns { ok: true, body } on 2xx (body is Instantly's raw response),",
    "{ ok: false, httpStatus, error } on non-2xx. Surface 4xx/5xx to the",
    "operator instead of retrying silently.",
  ].join(" "),
  extendsToolkit: "instantly",
  inputParams: z.object({
    eaccount: z.string().describe(
      "Sender mailbox slug — `email_account` on Instantly email records. " +
        "Must match the original outbound mailbox unless the operator " +
        "explicitly overrides.",
    ),
    reply_to_uuid: z.string().describe(
      "Email UUID — the `id` field on an Instantly email record (from a " +
        "webhook payload, COMPOSIO_SEARCH_TOOLS results, or any Instantly " +
        "list/get action). NOT a thread ID.",
    ),
    subject: z.string().describe("Reply subject, e.g. 'Re: <original subject>'."),
    body_html: z.string().describe("Approved reply as HTML. Required alongside body_text."),
    body_text: z.string().describe("Approved reply as plaintext. Required alongside body_html."),
  }),
  // Use `function` (not arrow) so we can preserve `this` when calling
  // ctx.proxyExecute via `.call(ctx, ...)`. The SDK's proxyExecute relies on
  // `this.client` internally and breaks when invoked as a free function.
  execute: async function (input, ctx) {
    debug("[REPLY_TO_EMAIL] dispatch eaccount=" + input.eaccount + " reply_to_uuid=" + input.reply_to_uuid);
    const proxyCtx = ctx as unknown as ProxyCtx;
    let res: ProxyResponse;
    try {
      res = await proxyCtx.proxyExecute.call(ctx, {
        toolkit: "instantly",
        endpoint: "/emails/reply",
        method: "POST",
        body: {
          eaccount: input.eaccount,
          reply_to_uuid: input.reply_to_uuid,
          subject: input.subject,
          body: { html: input.body_html, text: input.body_text },
        },
      });
    } catch (err) {
      const msg = String((err as { message?: string })?.message ?? err);
      console.error("[REPLY_TO_EMAIL] proxyExecute threw: " + msg);
      return { ok: false, error: msg };
    }
    const status = res.status ?? 0;
    const body = (res.data ?? {}) as Record<string, unknown>;
    debug("[REPLY_TO_EMAIL] status=" + String(status));
    if (status < 200 || status >= 300) {
      console.error("[REPLY_TO_EMAIL] non-2xx: " + status + " " + JSON.stringify(body).slice(0, 240));
      return { ok: false, httpStatus: status, error: body };
    }
    return { ok: true, body };
  },
});
