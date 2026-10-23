import { describe, expect, it } from "vitest";
import { dailyFileName } from "../lib/logger";

describe("dailyFileName", () => {
  const time = new Date(2026, 9, 23, 15, 30); // 2026-10-23 本地时间

  it("在扩展名前插入日期", () => {
    expect(dailyFileName("data/app.log", time)).toBe("app-2026-10-23.log");
  });

  it("只取basename，忽略目录", () => {
    expect(dailyFileName("/var/lib/comprehensible-english/logs/llm-calls.jsonl", time)).toBe(
      "llm-calls-2026-10-23.jsonl",
    );
  });

  it("月日补零", () => {
    expect(dailyFileName("app.log", new Date(2026, 0, 5))).toBe("app-2026-01-05.log");
  });

  it("无扩展名时直接拼日期", () => {
    expect(dailyFileName("data/app", time)).toBe("app-2026-10-23");
  });
});
