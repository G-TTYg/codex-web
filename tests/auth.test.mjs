import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Fastify from "fastify";
import ts from "typescript";

const sourcePath = new URL("../src/server/auth.ts", import.meta.url);
let moduleSequence = 0;

async function loadAuthModule() {
  const source = await readFile(sourcePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "auth.ts",
  });
  moduleSequence += 1;
  const encoded = Buffer.from(outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}#${moduleSequence}`);
}

async function createAuthApp() {
  const { createPasswordAuth } = await loadAuthModule();
  const app = Fastify();
  createPasswordAuth("correct-password").install(app);
  app.get("/", async () => "ok");
  return app;
}

function assertLocalizedPage(response, locale, messages) {
  assert.equal(response.statusCode, 401);
  assert.equal(response.headers["content-language"], locale);
  assert.equal(response.headers.vary, "Accept-Language");
  assert.match(response.body, new RegExp(`<html lang="${locale}">`));
  for (const message of messages) {
    assert.ok(response.body.includes(message), `missing message: ${message}`);
  }
}

test("password login follows browser language preferences", async (suite) => {
  const app = await createAuthApp();
  suite.after(() => app.close());

  await suite.test("uses Traditional Chinese for Taiwan browsers", async () => {
    const response = await app.inject({
      headers: { "accept-language": "zh-TW,zh;q=0.9,en;q=0.8" },
      method: "GET",
      url: "/",
    });
    assertLocalizedPage(response, "zh-Hant", [
      "輸入存取密碼以繼續。",
      "密碼",
      "登入",
    ]);
  });

  await suite.test(
    "uses Simplified Chinese for mainland browsers",
    async () => {
      const response = await app.inject({
        headers: { "accept-language": "zh-CN,zh;q=0.9" },
        method: "GET",
        url: "/",
      });
      assertLocalizedPage(response, "zh-Hans", [
        "输入访问密码以继续。",
        "密码",
        "登录",
      ]);
    },
  );

  await suite.test(
    "honors quality weights instead of header order",
    async () => {
      const response = await app.inject({
        headers: { "accept-language": "en-US;q=0.5,zh-HK;q=0.9" },
        method: "GET",
        url: "/",
      });
      assertLocalizedPage(response, "zh-Hant", ["輸入存取密碼以繼續。"]);
    },
  );

  await suite.test(
    "falls back to English for unsupported languages",
    async () => {
      const response = await app.inject({
        headers: { "accept-language": "ja-JP,ko;q=0.8" },
        method: "GET",
        url: "/",
      });
      assertLocalizedPage(response, "en", [
        "Enter the access password to continue.",
        "Password",
        "Continue",
      ]);
    },
  );

  await suite.test("localizes an invalid-password response", async () => {
    const response = await app.inject({
      headers: {
        "accept-language": "zh-Hant",
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      payload: "password=incorrect",
      url: "/__auth/login?next=%2F",
    });
    assertLocalizedPage(response, "zh-Hant", ["密碼不正確，請重試。"]);
    assert.match(response.body, /role="alert"/);
  });
});
