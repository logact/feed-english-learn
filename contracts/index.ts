import { z } from "zod";
import {
  UserProfileSchema,
  ProfileSessionUpdateSchema,
  StageReviewOutputSchema,
  LookupPredictionSchema,
} from "./profile";
import { KnowledgeItemSchema, KnowledgeChangeSchema } from "./knowledge";
import { ReadingEventSchema, MaterialMetaSchema } from "./events";
import { TargetSpecSchema } from "./target-spec";
import { GeneratorTurnSchema, DraftReportSchema, GeneratedMaterialSchema } from "./generator";

export const CONTRACTS = {
  UserProfile: UserProfileSchema,
  ProfileSessionUpdate: ProfileSessionUpdateSchema,
  StageReviewOutput: StageReviewOutputSchema,
  LookupPrediction: LookupPredictionSchema,
  KnowledgeItem: KnowledgeItemSchema,
  KnowledgeChange: KnowledgeChangeSchema,
  ReadingEvent: ReadingEventSchema,
  MaterialMeta: MaterialMetaSchema,
  TargetSpec: TargetSpecSchema,
  GeneratorTurn: GeneratorTurnSchema,
  DraftReport: DraftReportSchema,
  GeneratedMaterial: GeneratedMaterialSchema,
} as const;

export type ContractName = keyof typeof CONTRACTS;

export function contractJsonSchema(name: ContractName): Record<string, unknown> {
  return z.toJSONSchema(CONTRACTS[name]) as Record<string, unknown>;
}
