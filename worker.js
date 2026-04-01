export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({
        ok: true,
        service: "site-builder-worker",
        endpoint: "/api/chat"
      }, 200, corsHeaders);
    }

    if (request.method === "GET" && url.pathname === "/api/chat") {
      return json({
        ok: true,
        message: "use POST with { messages: [...], existingHtml?: string, requestMeta?: object }"
      }, 200, corsHeaders);
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      try {
        const XAI_API_KEY = env?.XAI_API_KEY;
        const XAI_API_URL = env?.XAI_API_URL || "https://api.x.ai/v1/chat/completions";
        const XAI_MODEL = env?.XAI_MODEL || "grok-4-1-fast-reasoning";
        const MAX_CONTEXT_MESSAGES = 6;

        if (!XAI_API_KEY) {
          return json({ ok: false, error: "Missing XAI_API_KEY secret" }, 500, corsHeaders);
        }

        const body = await request.json().catch(() => ({}));
        const incomingMessages = Array.isArray(body.messages) ? body.messages : [];
        const existingHtml = String(body.existingHtml || "").trim();
        const requestMeta = typeof body.requestMeta === "object" && body.requestMeta ? body.requestMeta : {};

        if (!incomingMessages.length) {
          return json({ ok: false, error: "Missing messages array" }, 400, corsHeaders);
        }

        const normalizedMessages = incomingMessages
          .map((m) => ({
            role: normalizeRole(m.role),
            content: String(m.content || "").trim()
          }))
          .filter((m) => m.content);

        const lastMessages = normalizedMessages.slice(-MAX_CONTEXT_MESSAGES);
        const inferredIntent = inferIntent_(lastMessages, existingHtml);

        const systemPrompt = `
You are an advanced AI website-building and website-editing engine.

Core context constraints:
- Active context is only the last 6 messages in this request.
- If existingHtml is provided, it is the required base.
- Do not rebuild from scratch unless user explicitly requests it.

Critical output format:
- Always return a complete, runnable HTML file.
- Never return only a patch/diff.
- The HTML must include a visible download button labeled "הורד" that downloads the generated HTML file.
- Keep all essential parameters and functionality requested in context.
- Response language for any user-facing text must be Hebrew.

Quality rules:
- Professional production-level output.
- Responsive layout.
- Clean structure and valid code.

The inferred task in this request is:
${inferredIntent}
`.trim();

        const developerPrompt = `
Execution rules:
1. Use only the provided 6-message context window.
2. If existingHtml exists, improve/modify that code rather than replacing unrelated parts.
3. Return code-first answer.
4. Output exactly one full HTML in a fenced code block (\`\`\`html ... \`\`\`).
5. Ensure the HTML includes a working download button.
6. Keep and improve parameters/features as requested in context.
7. If requestMeta exists, treat it as technical hints only.
`.trim();

        const contextPrompt = buildContextPrompt_(existingHtml, inferredIntent, requestMeta);

        const messages = [
          { role: "system", content: systemPrompt },
          { role: "system", content: developerPrompt },
          { role: "system", content: contextPrompt },
          ...lastMessages
        ];

        const payload = {
          model: XAI_MODEL,
          messages,
          stream: false,
          temperature: 0.25
        };

        const res = await fetch(XAI_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${XAI_API_KEY}`
          },
          body: JSON.stringify(payload)
        });

        const rawText = await res.text();

        if (!res.ok) {
          return json({
            ok: false,
            error: "xAI request failed",
            status: res.status,
            details: rawText
          }, 500, corsHeaders);
        }

        let data;
        try {
          data = JSON.parse(rawText);
        } catch {
          return json({ ok: false, error: "xAI returned invalid JSON", details: rawText }, 500, corsHeaders);
        }

        const content = data?.choices?.[0]?.message?.content;
        if (!content || !String(content).trim()) {
          return json({ ok: false, error: "No content returned from xAI", raw: data }, 500, corsHeaders);
        }

        return json({
          ok: true,
          inferredIntent,
          usedMessagesCount: lastMessages.length,
          maxContextMessages: MAX_CONTEXT_MESSAGES,
          requestMeta,
          content: String(content)
        }, 200, corsHeaders);
      } catch (err) {
        return json({ ok: false, error: err?.message || "Unknown server error" }, 500, corsHeaders);
      }
    }

    return json({ ok: false, error: "Not found" }, 404, corsHeaders);
  }
};

function inferIntent_(incomingMessages, existingHtml) {
  const text = incomingMessages.map((m) => String(m.content || "")).join("\n").toLowerCase();
  const hasExistingHtml = !!existingHtml;

  const rebuildWords = ["תבנה מחדש", "תתחיל מהתחלה", "rebuild", "start over", "from scratch"];
  const fixWords = ["תקן", "שגיאה", "באג", "לא עובד", "bug", "error", "fix", "not working"];
  const improveWords = ["שפר", "שדרג", "שיפור", "improve", "upgrade", "enhance"];
  const changeWords = ["תוסיף", "תעדכן", "תשנה", "change", "update", "edit", "add", "remove"];

  if (containsAny_(text, rebuildWords)) return "יצירה מחדש";
  if (hasExistingHtml && containsAny_(text, fixWords)) return "תיקון";
  if (hasExistingHtml && containsAny_(text, improveWords)) return "שיפור";
  if (hasExistingHtml && containsAny_(text, changeWords)) return "שינוי";
  return hasExistingHtml ? "שינוי" : "יצירה";
}

function buildContextPrompt_(existingHtml, inferredIntent, requestMeta) {
  const metaText = JSON.stringify(requestMeta || {}, null, 2);

  if (!existingHtml) {
    return `
No existing HTML was provided.
Inferred task: ${inferredIntent}
Request metadata:
${metaText}
`.trim();
  }

  return `
Existing HTML was provided.
Inferred task: ${inferredIntent}
Request metadata:
${metaText}

Base HTML to modify:
${existingHtml}
`.trim();
}

function containsAny_(text, words) {
  return words.some((word) => text.includes(word));
}

function normalizeRole(role) {
  const r = String(role || "").toLowerCase();
  if (r === "system" || r === "assistant" || r === "user") return r;
  return "user";
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}
