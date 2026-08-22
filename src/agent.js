import { GoogleGenerativeAI } from "@google/generative-ai";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { toolDeclarations, runTool } from "./tools.js";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const MEMORY_WINDOW = Number(process.env.MEMORY_WINDOW || 10); // messages kept, not exchanges

// sessionId -> [{role:"user",parts:[{text}]}, {role:"model",parts:[{text}]}, ...]
//
// Deliberately stores only the final visible text of each turn, not the
// intermediate tool-call / tool-response parts. This mirrors how n8n's
// memoryBufferWindow (LangChain memory) behaves — it remembers the
// conversation, not the tool-call scratchpad — and it means trimming the
// window can never cut a session off in the middle of an unfinished
// function-call pair, which the Gemini API would reject.
const sessions = new Map();

function getHistory(sessionId) {
  return sessions.get(sessionId) ?? [];
}

function appendTurn(sessionId, userText, modelText) {
  const history = getHistory(sessionId);
  history.push({ role: "user", parts: [{ text: userText }] });
  history.push({ role: "model", parts: [{ text: modelText }] });
  sessions.set(sessionId, history.slice(-MEMORY_WINDOW));
}

export async function runAgent(sessionId, userMessage) {
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
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
  const chat = model.startChat({ history: [...getHistory(sessionId)] });

  let result = await chat.sendMessage(userMessage);
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

    result = await chat.sendMessage(functionResponseParts);
    response = result.response;
  }

  if (!calledAnyTool) {
    console.log(
      "[agent] model answered WITHOUT calling any tool — reply is not grounded in Supabase data"
    );
  }

  const text = response.text();
  appendTurn(sessionId, userMessage, text);
  return text;
}

export function resetSession(sessionId) {
  sessions.delete(sessionId);
}
