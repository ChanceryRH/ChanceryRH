export const PRODUCTIVITY_UPDATES = [
  {
    id: "chat_library",
    name: "Chat Library",
    description: "Find, rename, pin, and archive your saved conversations.",
  },
  {
    id: "chat_branches",
    name: "Conversation Branches",
    description:
      "Explore another direction while keeping the original conversation.",
  },
  {
    id: "answer_vault",
    name: "Answer Vault",
    description: "Keep useful answers in a searchable personal collection.",
  },
  {
    id: "conversation_exports",
    name: "Conversation Exports",
    description: "Take your saved conversations with you as Markdown or JSON.",
  },
  {
    id: "personal_instructions",
    name: "Personal Instructions",
    description: "Choose reusable context for your next AI request.",
  },
  {
    id: "draft_recovery",
    name: "Draft Recovery",
    description:
      "Save unfinished prompts securely and restore them when ready.",
  },
  {
    id: "model_favorites",
    name: "Model Favorites",
    description: "Keep your preferred available models close at hand.",
  },
  {
    id: "spend_radar",
    name: "Spend Radar",
    description:
      "See where usage and seat fees went, with receipt-backed totals.",
  },
  {
    id: "request_history",
    name: "Request History",
    description: "Inspect previous requests without sending them again.",
  },
  {
    id: "action_lists",
    name: "Action Lists",
    description:
      "Track personal tasks, due dates, and the conversations behind them.",
  },
] as const;
export type ProductivityId = (typeof PRODUCTIVITY_UPDATES)[number]["id"];
export const productivityIds = PRODUCTIVITY_UPDATES.map((x) => x.id);
export type PersonalItem = {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  value: Record<string, any>;
};
