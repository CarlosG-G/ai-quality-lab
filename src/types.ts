export interface Doc {
  id: string;
  type: 'product' | 'policy';
  title: string;
  tags: string[];
  text: string;
  price?: number;
  inStock?: boolean;
  warrantyYears?: number;
}

export interface Retrieved {
  doc: Doc;
  score: number;
}

export type RefusalReason = 'prompt_injection' | 'out_of_scope' | 'invalid_input';

export interface BotAnswer {
  answer: string;
  sources: string[];
  refused: boolean;
  reason?: RefusalReason;
  provider: string;
  latencyMs: number;
}

export interface GenerateInput {
  question: string;
  context: Retrieved[];
}

export interface LlmProvider {
  readonly name: string;
  generate(input: GenerateInput): Promise<string>;
}
