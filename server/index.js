require("dotenv").config();
const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 8787;

app.use(cors());
app.use(express.json({ limit: "200kb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 🔥 Prompt template for ghost suggestions
function buildSystemPrompt() {
  return `
You are a prompt optimization assistant.

Your task:
- Do NOT include words like "Add:", "Suggestion:", or any prefix.
- Improve the user's prompt.
- Return ONLY a short append-only suggestion.
- Do NOT rewrite the entire prompt.
- Do NOT explain.
- If the prompt is already clear, return empty string.

Examples:
User: Explain neural networks
Output: Add: at a beginner level with a simple real-world example.

User: Write code for sorting
Output: Specify language and input constraints.
`;
}

app.post("/suggest", async (req, res) => {
  try {
    const text = req.body.text?.trim();
    if (!text || text.length < 10) {
      return res.json({ ghostText: "" });
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini", // cheap + fast
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: text },
      ],
      temperature: 0.3,
      max_tokens: 60,
    });

    const suggestion =
      completion.choices?.[0]?.message?.content?.trim() || "";

    res.json({ ghostText: suggestion });
  } catch (err) {
    console.error("OpenAI error:", err.message);
    res.json({ ghostText: "" });
  }
});

app.post("/suggestFinal", async (req, res) => {
  try {
    const text = (req.body?.text || "").trim();
    if (!text) return res.json({ rewritten: "" });

    // Optional: limit to prevent huge prompts
    if (text.length > 6000) return res.json({ rewritten: "" });

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content: `
You are a prompt editor. Your job is to improve the user's prompt for clarity, grammar, and specificity WITHOUT changing intent.

Return ONLY the rewritten prompt (plain text) or return an empty string if no changes are needed.

Rules:
- Preserve meaning and user intent.
- Fix grammar, spelling, punctuation, and structure.
- If the prompt is vague, you may add light clarification scaffolding (e.g., "Provide steps", "Include code") ONLY if strongly implied by the user's wording.
- Do NOT add new requirements that the user did not imply.
- Do NOT include prefixes like "Rewritten:" or quotes or markdown.
- If the original is already good, return empty string.
`.trim()
        },
        { role: "user", content: text }
      ]
    });

    const rewritten = (completion.choices?.[0]?.message?.content || "").trim();

    // Safety cleanup: if model returns the same thing, treat as "no rewrite"
    if (!rewritten || rewritten === text) return res.json({ rewritten: "" });

    return res.json({ rewritten });
  } catch (err) {
    console.error("suggestFinal error:", err);
    return res.json({ rewritten: "" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 LLM Suggestion server running at http://localhost:${PORT}`);
});