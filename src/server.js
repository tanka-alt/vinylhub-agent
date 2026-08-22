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
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// Optional utility — not part of the original workflow, but handy for
// testing: clears one session's memory without restarting the server.
app.post("/webhook/reset", (req, res) => {
  const { sessionId } = req.body ?? {};
  if (!sessionId) return res.status(400).json({ error: "sessionId is required" });
  resetSession(sessionId);
  res.json({ ok: true });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`VinylHub agent listening on :${port}`);
});
