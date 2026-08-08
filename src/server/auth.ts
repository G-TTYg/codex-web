import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";

const AUTH_PATH = "/__auth/login";
const SESSION_COOKIE_NAME = "codex_web_session";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function constantTimeMatches(expected: Buffer, candidate: string): boolean {
  return timingSafeEqual(expected, digest(candidate));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeNextPath(requestUrl: string): string {
  const requested = new URL(
    requestUrl,
    "http://codex-web.local",
  ).searchParams.get("next");
  return requested?.startsWith("/") && !requested.startsWith("//")
    ? requested
    : "/";
}

function loginPage(nextPath: string, invalidPassword: boolean): string {
  const action = `${AUTH_PATH}?next=${encodeURIComponent(nextPath)}`;
  const error = invalidPassword
    ? '<p class="error" role="alert">密碼不正確，請重試。</p>'
    : "";

  return `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <title>Codex Web</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f7f7f7;
        color: #171717;
      }
      * { box-sizing: border-box; }
      body {
        min-height: 100dvh;
        margin: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        background: radial-gradient(circle at 50% 0%, #fff 0, #f7f7f7 48%, #f1f1f1 100%);
      }
      dialog {
        position: static;
        width: min(100%, 360px);
        margin: 0;
        padding: 24px;
        border: 1px solid rgba(0, 0, 0, 0.1);
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.94);
        color: inherit;
        box-shadow: 0 18px 55px rgba(0, 0, 0, 0.14);
      }
      h1 { margin: 0 0 8px; font-size: 20px; line-height: 1.3; }
      p { margin: 0 0 20px; color: #666; font-size: 14px; line-height: 1.5; }
      label { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 600; }
      input {
        width: 100%;
        min-height: 44px;
        padding: 10px 12px;
        border: 1px solid rgba(0, 0, 0, 0.18);
        border-radius: 10px;
        background: transparent;
        color: inherit;
        font: inherit;
        outline: none;
      }
      input:focus { border-color: #777; box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.08); }
      button {
        width: 100%;
        min-height: 44px;
        margin-top: 14px;
        border: 0;
        border-radius: 10px;
        background: #171717;
        color: #fff;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
      .error { margin: 10px 0 0; color: #c62828; }
      @media (prefers-color-scheme: dark) {
        :root { background: #171717; color: #f5f5f5; }
        body { background: radial-gradient(circle at 50% 0%, #282828 0, #171717 55%, #111 100%); }
        dialog { border-color: rgba(255, 255, 255, 0.12); background: rgba(35, 35, 35, 0.96); box-shadow: 0 18px 55px rgba(0, 0, 0, 0.45); }
        p { color: #aaa; }
        input { border-color: rgba(255, 255, 255, 0.2); }
        input:focus { border-color: #aaa; box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.09); }
        button { background: #f2f2f2; color: #171717; }
        .error { color: #ff8a80; }
      }
    </style>
  </head>
  <body>
    <dialog open aria-labelledby="auth-title">
      <form method="post" action="${escapeHtml(action)}">
        <h1 id="auth-title">Codex Web</h1>
        <p>輸入訪問密碼以繼續。</p>
        <label for="password">密碼</label>
        <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
        ${error}
        <button type="submit">進入</button>
      </form>
    </dialog>
  </body>
</html>`;
}

function sendLoginPage(
  reply: FastifyReply,
  nextPath: string,
  invalidPassword: boolean,
  statusCode: number,
): FastifyReply {
  return reply
    .code(statusCode)
    .headers({
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    })
    .send(loginPage(nextPath, invalidPassword));
}

function cookieValues(headers: IncomingHttpHeaders, name: string): string[] {
  const header = headers.cookie;
  if (!header) {
    return [];
  }

  return header.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) {
      return [];
    }
    return [part.slice(separator + 1).trim()];
  });
}

export type PasswordAuth = {
  enabled: boolean;
  install: (app: FastifyInstance) => void;
  isAuthorized: (headers: IncomingHttpHeaders) => boolean;
  rejectUpgrade: (socket: Duplex) => void;
};

export function createPasswordAuth(password: string | undefined): PasswordAuth {
  const enabled = password != null && password.length > 0;
  const expectedPassword = digest(password ?? "");
  const sessionToken = randomBytes(32).toString("base64url");
  const expectedSession = digest(sessionToken);

  const isAuthorized = (headers: IncomingHttpHeaders): boolean =>
    !enabled ||
    cookieValues(headers, SESSION_COOKIE_NAME).some((candidate) =>
      constantTimeMatches(expectedSession, candidate),
    );

  return {
    enabled,
    isAuthorized,
    install(app): void {
      if (!enabled) {
        return;
      }

      app.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, body),
      );

      app.addHook("onRequest", async (request, reply) => {
        const pathname = new URL(request.url, "http://codex-web.local")
          .pathname;
        if (pathname === AUTH_PATH || isAuthorized(request.headers)) {
          return;
        }

        if (request.method === "GET" || request.method === "HEAD") {
          return sendLoginPage(reply, request.url, false, 401);
        }
        return reply.code(401).send({ error: "Unauthorized" });
      });

      app.get(AUTH_PATH, async (request, reply) =>
        sendLoginPage(reply, safeNextPath(request.url), false, 200),
      );

      app.post(AUTH_PATH, { bodyLimit: 4 * 1024 }, async (request, reply) => {
        const nextPath = safeNextPath(request.url);
        const form = new URLSearchParams(
          typeof request.body === "string" ? request.body : "",
        );
        if (
          !constantTimeMatches(expectedPassword, form.get("password") ?? "")
        ) {
          return sendLoginPage(reply, nextPath, true, 401);
        }

        const secure = request.protocol === "https" ? "; Secure" : "";
        return reply
          .code(303)
          .headers({
            "cache-control": "no-store",
            location: nextPath,
            "set-cookie": `${SESSION_COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict${secure}`,
          })
          .send();
      });
    },
    rejectUpgrade(socket): void {
      socket.end(
        "HTTP/1.1 401 Unauthorized\r\n" +
          "Connection: close\r\n" +
          "Content-Type: text/plain; charset=utf-8\r\n" +
          "Content-Length: 12\r\n" +
          "\r\n" +
          "Unauthorized",
      );
    },
  };
}
