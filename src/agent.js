import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { toolDeclarations, runTool } from "./tools.js";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
// If the main model is overloaded (503) or gone (404), try these in order.
// Override with a comma-separated GEMINI_FALLBACK_MODELS env variable.
const FALLBACK_MODELS = (
  process.env.GEMINI_FALLBACK_MODELS ?? "gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MODELS = [...new Set([MODEL_NAME, ...FALLBACK_MODELS])];
const MEMORY_WINDOW = Number(process.env.MEMORY_WINDOW || 10); // messages kept, not exchanges

// sessionId -> [{role:"user",parts:[{text}]}, {role:"model",parts:[{text}]}, ...]
//
// Deliberately stores only the final visible text of each turn, not the
// intermediate tool-call / tool-response parts. This mirrors how n8n's
// memoryBufferWindow (LangChain memory) behaves — it remembers the
// conversation, not the tool-call scratchpad — and it means trimming the
// window can never cut a session off in the middle of an unfinished
// function-call pair, which the Gemini API would reject.
//
// Persisted in the Supabase table "chat_sessions" so memory survives
// serverless cold starts / different instances (Vercel). The in-memory Map
// below is only a fallback if Supabase is unreachable.
const sessions = new Map();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const SESSIONS_TABLE = "chat_sessions";

async function getHistory(sessionId) {
  const { data, error } = await supabase
    .from(SESSIONS_TABLE)
    .select("messages")
    .eq("session_id", sessionId)
    .maybeSingle();

  if (error) {
    console.error("[memory] load failed, using in-memory fallback:", error.message);
    return sessions.get(sessionId) ?? [];
  }
  return data?.messages ?? [];
}

async function appendTurn(sessionId, userText, modelText) {
  const history = await getHistory(sessionId);
  history.push({ role: "user", parts: [{ text: userText }] });
  history.push({ role: "model", parts: [{ text: modelText }] });
  const trimmed = history.slice(-MEMORY_WINDOW);
  sessions.set(sessionId, trimmed);

  const { error } = await supabase.from(SESSIONS_TABLE).upsert({
    session_id: sessionId,
    messages: trimmed,
    updated_at: new Date().toISOString(),
  });
  if (error) console.error("[memory] save failed:", error.message);
}

// Gemini sometimes answers 503 ("high demand") or 429 (rate limit) for a few
// seconds at a time. Retry a few times with a growing pause before giving up.
async function sendWithRetry(chat, message, attempts = 2) {
  for (let i = 1; ; i++) {
    try {
      return await chat.sendMessage(message);
    } catch (err) {
      const retryable = [429, 500, 503].includes(err?.status);
      if (!retryable || i >= attempts) throw err;
      const waitMs = 1000 * 2 ** (i - 1); // 1s, 2s, 4s
      console.log(`[agent] Gemini ${err.status}, retry ${i}/${attempts - 1} in ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

async function runWithModel(modelName, history, userMessage) {
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: SYSTEM_PROMPT,
    tools: [{ functionDeclarations: toolDeclarations }],
    generationConfig: { temperature: 0.4 },
  });

  // IMPORTANT: pass a COPY of the stored history, not the array itself.
  // The @google/generative-ai SDK mutates the array it's given in place as
  // the conversation (and any tool calls) progress — if we hand it our
  // actual stored session array by reference, its internal bookkeeping
  // (including role:"function" entries from tool calls) leaks straight
  // into what we persist, eventually corrupting the stored history so the
  // next request's first entry isn't role:"user" and the API rejects it.
  const chat = model.startChat({ history: [...history] });

  let result = await sendWithRetry(chat, userMessage);
  let response = result.response;

  // The agent may call a tool, read the result, then call another tool
  // before it has enough to answer — loop until it stops calling tools.
  let guard = 0;
  let calledAnyTool = false;
  while (true) {
    const calls = response.functionCalls();
    if (!calls || calls.length === 0) break;
    calledAnyTool = true;
    if (++guard > 6) {
      throw new Error("Too many chained tool calls — aborting to avoid a loop.");
    }

    console.log(
      `[agent] model requested ${calls.length} tool call(s): ${calls.map((c) => c.name).join(", ")}`
    );

    const functionResponseParts = [];
    for (const call of calls) {
      let output;
      try {
        output = await runTool(call.name, call.args);
      } catch (err) {
        output = { error: String(err?.message || err) };
      }
      functionResponseParts.push({
        functionResponse: { name: call.name, response: { result: output } },
      });
    }

    result = await sendWithRetry(chat, functionResponseParts);
    response = result.response;
  }

  if (!calledAnyTool) {
    console.log(
      "[agent] model answered WITHOUT calling any tool — reply is not grounded in Supabase data"
    );
  }

  return response.text();
}

export async function runAgent(sessionId, userMessage) {
  const history = await getHistory(sessionId);

  let lastError;
  for (const modelName of MODELS) {
    try {
      const text = await runWithModel(modelName, history, userMessage);
      await appendTurn(sessionId, userMessage, text);
      return text;
    } catch (err) {
      lastError = err;
      // Only switch model for "this model is busy / rate-limited / gone" errors;
      // anything else (bad API key, bug in our code) would fail on every model.
      if (![404, 429, 500, 503].includes(err?.status)) throw err;
      console.log(`[agent] model ${modelName} failed with ${err.status}, trying next fallback`);
    }
  }
  throw lastError;
}

export async function resetSession(sessionId) {
  sessions.delete(sessionId);
  const { error } = await supabase.from(SESSIONS_TABLE).delete().eq("session_id", sessionId);
  if (error) console.error("[memory] reset failed:", error.message);
}
