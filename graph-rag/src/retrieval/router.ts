export type QueryType = "global" | "local" | "drift" | "temporal" | "attribute";

const TEMPORAL_PATTERN =
  /\b(when|timeline|history|chronolog|last\s+(week|month|year|quarter)|in\s+(january|february|march|april|may|june|july|august|september|october|november|december)|before\s+\d{4}|after\s+\d{4}|during\s+\d{4}|\d{4}-\d{2})/i;

const ATTRIBUTE_PATTERN =
  /\b(status|priority|type|author|tagged|category|rating|where\s+\S+\s+is|with\s+attribute|has\s+property)\b/i;

const GLOBAL_PATTERN =
  /\b(overview|main\s+themes|summarize\s+(all|my|the|everything)|what\s+do\s+i\s+know|across\s+all|big\s+picture|high[\s-]level|major\s+topics|domains|areas\s+of)\b/i;

export function classifyQuery(query: string): QueryType {
  if (TEMPORAL_PATTERN.test(query)) return "temporal";
  if (ATTRIBUTE_PATTERN.test(query)) return "attribute";
  if (GLOBAL_PATTERN.test(query)) return "global";

  // Multi-faceted queries -> DRIFT
  const clauses = query.split(/\b(and|but|also|however|additionally|furthermore|moreover)\b/i);
  if (clauses.length > 2) return "drift";

  return "local";
}
