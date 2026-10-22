import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { isSecureRequest } from "../lib/session";

describe("会话 Cookie 安全标记", () => {
  it("按请求协议设置 Secure，支持生产环境的 HTTP 部署", () => {
    expect(isSecureRequest(new NextRequest("http://example.com/api/auth/login"))).toBe(false);
    expect(isSecureRequest(new NextRequest("https://example.com/api/auth/login"))).toBe(true);
  });

  it("使用反向代理传递的原始协议", () => {
    const https = new NextRequest("http://example.com/api/auth/login", {
      headers: { "x-forwarded-proto": "https" },
    });
    const http = new NextRequest("https://example.com/api/auth/login", {
      headers: { "x-forwarded-proto": "http" },
    });

    expect(isSecureRequest(https)).toBe(true);
    expect(isSecureRequest(http)).toBe(false);
  });
});
