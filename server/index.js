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
- Improve the user's prompt.
- Return ONLY a short append-only suggestion.
- Do NOT rewrite the entire prompt.
- Do NOT explain.
- Keep it under 20 words.
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

app.listen(PORT, () => {
  console.log(`🚀 LLM Suggestion server running at http://localhost:${PORT}`);
});