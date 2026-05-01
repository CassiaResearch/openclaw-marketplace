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
    "Send an approved reply on an Instantly email thread, pinned to the exact",
    "sender mailbox (eaccount) that sent the original outbound. Wraps Instantly's",
    "POST /emails/reply via Composio's managed Instantly connection.",
    "",
    "Use ONLY after a draft has been approved by the operator (e.g. in",
    "#emma-email-review, Slack channel C0AUKA00316). Do NOT use this tool for",
    "Gmail or other channels. Do NOT invent or modify reply content; send only",
    "the exact draft that was approved.",
    "",
    "Triggers: \"send the approved reply via instantly\", \"reply from",
    "[eaccount] to this instantly thread\", \"respond through instantly to",
    "[prospect]\", \"fire the instantly reply draft\", \"send my instantly",
    "draft\".",
    "",
    "On success returns { ok: true, body } where body is Instantly's raw",
    "response. On a non-2xx returns { ok: false, httpStatus, error }. Surface",
    "4xx/5xx to the operator rather than retrying silently.",
  ].join(" "),
  extendsToolkit: "instantly",
  inputParams: z.object({
    eaccount: z.string().describe(
      "Burner sender mailbox. Must match the email_account from the inbound webhook payload, OR the operator's explicit override.",
    ),
    reply_to_uuid: z.string().describe(
      "The id field from the inbound INSTANTLY_LIST_EMAILS entry being replied to. Email UUID, not a thread ID.",
    ),
    subject: z.string().describe("Reply subject. Usually 'Re: <original subject>'."),
    body_html: z.string().describe("The approved reply rendered as HTML."),
    body_text: z.string().describe("The approved reply as plaintext."),
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
