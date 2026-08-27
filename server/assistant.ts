// ─────────────────────────────────────────────────────────────────────────
// v20.36.0 — Lexi, the BGRE AI Assistant (Cortana vision).
// Voice-driven admin assistant reachable from /#/lexi.
// Talks over the Perplexity API, sees a live FUB snapshot every turn, and
// proposes write actions (e.g. create a task) that the admin must confirm
// out loud or by tapping Confirm before anything is written to FUB.
// See the `bgre-ai-assistant` skill (Alex's personal skill library) for the
// full delegation matrix / Cortana vision / tone spec this prompt is built
// from — keep this file's SYSTEM_PROMPT in sync if that skill changes.
// ─────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import { requireAdmin } from "./auth";
import { fubRequest } from "./fub";

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";
const PERPLEXITY_MODEL = "sonar-pro";

const ACTION_OPEN = "[[PROPOSE_ACTION]]";
const ACTION_CLOSE = "[[/PROPOSE_ACTION]]";

const SYSTEM_PROMPT = `Your name is Lexi. You are the standing AI Executive Assistant for Alex Watson and Nate Watson at Brothers Group Real Estate (BGRE) / Watson Brothers Group, Momentum Realty. Introduce yourself as Lexi the first time you speak in a session if it feels natural, and refer to yourself as Lexi (never "the assistant" or "the AI") when talking about yourself. You are speaking with them out loud through a voice portal — keep replies conversational, warm, and SHORT (1-4 sentences unless they ask for detail), since they are hearing this read aloud, not reading it.

## Who you're talking to
Alex Watson and Nate Watson — both Admins and Agents. Alex also runs Project Manager duties (repairs/inspections business, sales recruiting, agent training, app development). Nate is Head of Payments & Business Operations, and Head of Tax/Accounting/Payroll.

## Delegation matrix (who owns what)
- Admin (shared): Alex & Nate — contracts, business formation
- Project Manager (Alex): repairs/inspections business end-to-end, sales recruiting, agent training, app development
- Ops/Finance Head (Nate): payments, overall business operations, tax, accounting, payroll
- Agents: Alex, Nate, Gabriel Marcano, Gabriel Duran, Vonda Jewell — client showings, listings, buyer/seller questions, inspections
- ISA (Denise Jacobs): lead follow-up, appointment setting, CRM upkeep
- Lenders: Tyler Payne, Matt Sapienza — pre-approvals, loan status, closing coordination
When asked "who should handle X" or "who does this belong to," answer using this matrix.

## Your character — the Cortana vision
You are not a passive chatbot. You already know what's open across the business (you get a live snapshot of FUB tasks/deals every turn — use it, don't ask them to look it up themselves). Speak up about what matters without being asked. Flag blockers with a recommended next step. Never be purely transactional.

## Tone — motivation, gratitude, positivity
Always carry a warm, encouraging undertone: motivate them toward action, speak positively about them, their team, and their families, and point out real wins/progress when you see them in the live snapshot — not just what's outstanding. Never guilt-trip or nag; energize instead.

## Live FUB snapshot
You will be given a snapshot of open tasks and deals before each turn. Treat it as ground truth for "what's open right now." If it's empty or failed to load, say so plainly instead of guessing.

## Taking action — CONFIRM BEFORE YOU ACT
You can read freely and talk about anything in the snapshot. But you must NEVER silently create, change, or send anything. If Alex or Nate asks you to do something that requires a write (e.g. "add a task for...", "remind me to call..."), do this:
1. Say what you're about to do, in plain speech, ending with a clear yes/no question (e.g. "Want me to add that task?").
2. On the line right after your spoken reply, emit EXACTLY one action block in this format (only when proposing an action, never otherwise):
${ACTION_OPEN}{"type":"create_fub_task","title":"<short task title>","personName":"<name or empty string if general>","dueDate":"<YYYY-MM-DD or empty string>","notes":"<optional context>"}${ACTION_CLOSE}
Only use type "create_fub_task" — it is the only action type currently supported. Do not invent other action types. Do not emit an action block unless the user actually asked for something to be done.

## Financial reality — seasonal income, debt paydown, production focus
Real estate commissions are lumpy/seasonal, not a steady paycheck. Right now the business is in a tight cash-flow stretch — actively working a debt avalanche paydown plan (highest-APR debt first, minimums on the rest), building an emergency buffer, and treating the tithe as a fixed non-negotiable floor, never a paydown lever. This is a genuine turnaround in progress, not a crisis to dwell on. Let this color your tone: gently and naturally tie the value of closing deals, working leads, and hitting production to what it does for cash flow and the paydown timeline — without guilt-tripping or nagging. Frame it as fuel: "every closed deal moves the debt-free date forward," not doom. If Alex or Nate ask specifically about account balances, exact debt figures, APRs, or sinking funds, tell them plainly that you don't have live bank data wired in yet — that detail lives in the Watson CFO review (Plaid-backed) on the main Perplexity Computer session, not here — and offer to remind them to run a review there instead of guessing a number.

## Rules
- Never say "scrape" or "crawl."
- If you don't know something (e.g. calendar events — you do not have calendar access yet), say so plainly rather than guessing.
- Keep spoken replies short. Save detail for when they ask "tell me more."`;

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

async function fetchLiveFubSnapshot(): Promise<string> {
  try {
    const [tasksRes, dealsRes] = await Promise.all([
      fubRequest("GET", "/tasks?isCompleted=false&limit=15&sort=-created"),
      fubRequest("GET", "/deals?limit=8&sort=-updated"),
    ]);

    const tasks: any[] = tasksRes.data?.tasks || tasksRes.data?.data || [];
    const deals: any[] = dealsRes.data?.deals || dealsRes.data?.data || [];

    const taskLines = tasks.length
      ? tasks
          .slice(0, 15)
          .map((t: any) => {
            const due = t.dueDate || t.due_date || "no due date";
            const who = t.assignedTo || t.assigned_to || "unassigned";
            const person = t.person?.name || t.personName || "";
            return `- "${t.name || t.description || t.title || "Untitled task"}" (due ${due}, assigned to ${who}${person ? `, re: ${person}` : ""})`;
          })
          .join("\n")
      : "No open tasks right now.";

    const dealLines = deals.length
      ? deals
          .slice(0, 8)
          .map((d: any) => `- ${d.name || d.projectName || `Deal #${d.id}`} — stage: ${d.stage?.name || d.stage || d.status || "unknown"}`)
          .join("\n")
      : "No open deals right now.";

    return `OPEN TASKS (up to 15, most recent first):\n${taskLines}\n\nOPEN DEALS (up to 8, most recently updated):\n${dealLines}`;
  } catch (err: any) {
    console.warn("[Assistant] Failed to load FUB snapshot:", err?.message);
    return "Could not load the live FUB snapshot this turn — treat task/deal state as unknown and say so if asked.";
  }
}

function extractProposedAction(raw: string): { spoken: string; proposedAction: any | null } {
  const openIdx = raw.indexOf(ACTION_OPEN);
  const closeIdx = raw.indexOf(ACTION_CLOSE);
  if (openIdx === -1 || closeIdx === -1 || closeIdx < openIdx) {
    return { spoken: raw.trim(), proposedAction: null };
  }
  const spoken = (raw.slice(0, openIdx) + raw.slice(closeIdx + ACTION_CLOSE.length)).trim();
  const jsonStr = raw.slice(openIdx + ACTION_OPEN.length, closeIdx).trim();
  try {
    const proposedAction = JSON.parse(jsonStr);
    return { spoken, proposedAction };
  } catch {
    return { spoken, proposedAction: null };
  }
}

async function callPerplexity(messages: ChatMessage[]): Promise<string> {
  if (!PERPLEXITY_API_KEY) {
    throw new Error("PERPLEXITY_API_KEY is not set on the server.");
  }
  const resp = await fetch(PERPLEXITY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: PERPLEXITY_MODEL,
      messages,
      temperature: 0.4,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Perplexity API ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data: any = await resp.json();
  return data?.choices?.[0]?.message?.content || "";
}

// Resolve a spoken person name to a FUB person id via a lightweight name search.
async function resolveFubPersonId(personName: string): Promise<number | null> {
  if (!personName || !personName.trim()) return null;
  try {
    const res = await fubRequest("GET", `/people?limit=5&q=${encodeURIComponent(personName.trim())}`);
    const people: any[] = res.data?.people || res.data?.data || [];
    if (people.length === 1) return people[0].id;
    if (people.length > 1) {
      // Prefer an exact (case-insensitive) full-name match; otherwise take the first hit.
      const exact = people.find(
        (p: any) => `${p.firstName || ""} ${p.lastName || ""}`.trim().toLowerCase() === personName.trim().toLowerCase()
      );
      return (exact || people[0]).id;
    }
    return null;
  } catch (err: any) {
    console.warn("[Assistant] resolveFubPersonId failed:", err?.message);
    return null;
  }
}

export function registerAssistantRoutes(app: Express) {
  // POST /api/assistant/chat
  // Body: { messages: [{role:'user'|'assistant', content:string}, ...] }
  // (history is client-managed; server prepends system prompt + live snapshot fresh each turn)
  app.post("/api/assistant/chat", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      const history: ChatMessage[] = Array.isArray(req.body?.messages) ? req.body.messages : [];
      const snapshot = await fetchLiveFubSnapshot();
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "system", content: `Live FUB snapshot as of right now:\n${snapshot}` },
        ...history.filter((m) => m.role === "user" || m.role === "assistant"),
      ];
      const raw = await callPerplexity(messages);
      const { spoken, proposedAction } = extractProposedAction(raw);
      res.json({ reply: spoken, proposedAction });
    } catch (err: any) {
      console.error("[Assistant] /chat failed:", err?.message);
      res.status(500).json({ error: err?.message || "Assistant chat failed." });
    }
  });

  // POST /api/assistant/execute-action
  // Body: { action: { type:'create_fub_task', title, personName, dueDate, notes } }
  // Only called after the admin explicitly confirms a proposed action.
  app.post("/api/assistant/execute-action", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      const action = req.body?.action;
      if (!action || action.type !== "create_fub_task") {
        return res.status(400).json({ error: "Unsupported or missing action type." });
      }
      const admin = (req as any).currentAgent;
      const personId = action.personName ? await resolveFubPersonId(action.personName) : null;
      const payload: any = {
        name: action.title || "Untitled task",
        dueDate: action.dueDate || undefined,
        description: action.notes || undefined,
      };
      if (personId) payload.personId = personId;
      const taskRes = await fubRequest("POST", "/tasks", payload);
      if (!taskRes.ok) {
        return res.status(502).json({ error: "FUB rejected the task.", detail: taskRes.data });
      }
      console.log(`[Assistant] ${admin?.name || "admin"} confirmed task via voice portal: "${action.title}"`);
      res.json({ ok: true, taskId: taskRes.data?.id, attachedToPerson: !!personId });
    } catch (err: any) {
      console.error("[Assistant] /execute-action failed:", err?.message);
      res.status(500).json({ error: err?.message || "Action execution failed." });
    }
  });
}
