import { Type, type Static } from '@sinclair/typebox';
import { Id } from './knowledge.ts';
export const ExplainWordSchema = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 500 }),
    profileId: Id,
  },
  { additionalProperties: false },
);
export type ExplainWordInput = Static<typeof ExplainWordSchema>;
export function explanationPrompt(text: string) {
  return `${text.trim()}是什么？请以最简单的方式介绍它的概念`;
}
