export const MCP_SCOPES = [
  {
    id: "workspace:read",
    name: "Office overview",
    detail: "Office name, budget, and policies.",
  },
  {
    id: "models:read",
    name: "Available models",
    detail: "Models permitted by your Office.",
  },
  {
    id: "conversations:read",
    name: "Your conversations",
    detail:
      "Your saved conversations and messages. Never another member’s chats.",
  },
  {
    id: "ledger:read",
    name: "Spending and receipts",
    detail: "Only the records your Office role can already view.",
  },
  {
    id: "clerks:read",
    name: "Clerk status",
    detail: "Schedules and status, for owners and officers.",
  },
  {
    id: "requests:prepare",
    name: "Prepare AI requests",
    detail:
      "Prepare work for you to review. Execution requires your approval in Chancery.",
  },
] as const;
export type McpScope = (typeof MCP_SCOPES)[number]["id"];
export type McpConnection = {
  id: string;
  name: string;
  account_id: string;
  scopes: McpScope[];
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  paused_at: string | null;
  budgetUsd: string | null;
  maxRequestUsd: string | null;
  usedUsd: string;
  remainingUsd: string | null;
};
export type McpDraft = {
  id: string;
  connectionName: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  chat: {
    model: string;
    messages: { role: string; content: string }[];
    maxTokens: number;
    lane: string;
  };
  result?: {
    status: string;
    content: string | null;
    chargedUsd: string | null;
  };
};
