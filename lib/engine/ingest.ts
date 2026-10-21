// 事件摄入：校验外部输入为 ReadingEvent。body 可以是单个事件或数组。
import { ReadingEventSchema, type ReadingEvent } from "../../contracts/events";

export interface IngestResult {
  events: ReadingEvent[];
  errors: { index: number; error: string }[];
}

export function validateEvents(body: unknown): IngestResult {
  const rawList = Array.isArray(body) ? body : [body];
  const events: ReadingEvent[] = [];
  const errors: IngestResult["errors"] = [];
  rawList.forEach((raw, index) => {
    const parsed = ReadingEventSchema.safeParse(raw);
    if (parsed.success) events.push(parsed.data);
    else errors.push({ index, error: parsed.error.issues.map((i) => i.message).join("; ") });
  });
  return { events, errors };
}
