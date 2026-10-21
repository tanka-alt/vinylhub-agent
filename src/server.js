import "dotenv/config";
import express from "express";
import cors from "cors";
import { runAgent, resetSession } from "./agent.js";

const app = express();
app.use(express.json());

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.includes("*") ? true : allowedOrigins,
  })
);

app.get("/health", (_req, res) => res.json({ ok: true }));

const MESSAGE_ET =
  "Vabandame! VinylHub on prototüüp ja Gemini assistent on hetkel ülekoormatud. Palun proovi mõne minuti pärast uuesti.";
const MESSAGE_EN =
  "Sorry! VinylHub is a prototype and the Gemini assistant is currently overloaded. Please try again in a few minutes.";

// Very small language guess: Estonian unless the message clearly looks English.
// (The shop is Estonian, so Estonian is the default for short/unclear messages.)
function overloadedMessage(text) {
  const t = String(text).toLowerCase();
  const looksEstonian = /[õäöüšž]|\b(kas|mis|teil|ja|ei|palun|tere|mul|sul|kuidas|miks|kus|aitäh|tänan|ma|sa|või|ning)\b/.test(t);
  const looksEnglish = /\b(the|you|do|does|have|what|is|are|hi|hello|please|thanks|how|why|where|can|could|i|my|your|any)\b/.test(t);
  return looksEnglish && !looksEstonian ? MESSAGE_EN : MESSAGE_ET;
}

// Matches the request shape the @n8n/chat widget (and n8n's Chat Trigger
// node) sends: { action, sessionId, chatInput }.
//
// IMPORTANT — verify before switching the frontend over: open the browser
// Network tab while the OLD n8n-backed chat widget is still live, send it a
// message, and confirm the request body field names and the response body
// shape (this assumes the response is { "output": "<reply text>" }, which
// is what n8n's Agent node produces in "responseMode: lastNode"). If the
// widget expects something different, adjust just this route — nothing
// else in this project needs to change.
app.post("/webhook/chat", async (req, res) => {
  const { action, sessionId, chatInput } = req.body ?? {};

  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }

  if (action === "loadPreviousSession") {
    // No stored transcript is exposed via this endpoint (see src/agent.js —
    // memory is kept server-side per session, not replayed to the client).
    // This is a safe no-op response in case the widget calls it.
    return res.json({ previousMessages: [] });
  }

  if (!chatInput || typeof chatInput !== "string") {
    return res.status(400).json({ error: "chatInput (string) is required" });
  }

  try {
    const output = await runAgent(sessionId, chatInput);
    res.json({ output });
  } catch (err) {
    console.error("Agent error:", err);
    // Gemini overloaded / rate-limited / model gone, even after retries and
    // fallback models: show a friendly chat message instead of a raw error,
    // so visitors don't think the assistant is simply broken.
    if ([404, 429, 500, 503].includes(err?.status)) {
      return res.json({ output: overloadedMessage(chatInput) });
    }
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// Optional utility — not part of the original workflow, but handy for
// testing: clears one session's memory without restarting the server.
app.post("/webhook/reset", async (req, res) => {
  const { sessionId } = req.body ?? {};
  if (!sessionId) return res.status(400).json({ error: "sessionId is required" });
  await resetSession(sessionId);
  res.json({ ok: true });
});

// On Vercel the platform runs the exported app itself (serverless), so we
// must not call listen() there. Locally / on Render we still start a server.
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`VinylHub agent listening on :${port}`);
  });
}

export default app;
