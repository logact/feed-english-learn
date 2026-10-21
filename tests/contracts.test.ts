import { describe, it, expect } from "vitest";
import { CONTRACTS, contractJsonSchema } from "../contracts";

describe("contracts", () => {
  it("所有契约可导出 JSON Schema 且非空", () => {
    for (const name of Object.keys(CONTRACTS) as (keyof typeof CONTRACTS)[]) {
      const s = contractJsonSchema(name);
      expect(s).toBeTruthy();
      expect(JSON.stringify(s).length).toBeGreaterThan(50);
    }
  });

  it("尺度 2 契约的 JSON Schema 中不存在 band / vocab_estimate（结构性防震荡）", () => {
    const s = contractJsonSchema("ProfileSessionUpdate");
    const rs = (s.properties as Record<string, { properties?: Record<string, unknown> }>)
      .reading_state;
    expect(rs.properties).toBeDefined();
    expect(Object.keys(rs.properties!)).not.toContain("band");
    expect(Object.keys(rs.properties!)).not.toContain("vocab_estimate");
  });

  it("TargetSpec 契约包含生成引擎所需字段", () => {
    const s = contractJsonSchema("TargetSpec");
    const props = Object.keys((s.properties ?? {}) as Record<string, unknown>);
    for (const k of ["band", "length_words", "topics", "review_items", "new_item_budget", "avoid_items", "notes"]) {
      expect(props).toContain(k);
    }
  });
});
