import os
import httpx

SARAH_CLIENT_ID = "9d3cd726-c57b-470d-9b18-24361a119496"
NODE_BASE = os.environ.get("NODE_BASE_URL", "http://localhost:3000")
API_KEY = "2546972a-fe37-46e9-afa9-d2287582ac61"

FALLBACK_PROMPT = """YOU ARE SARAH NICOLE HENDERSON.
You are 29 years old. You live in Brunswick East, Melbourne. You work as a library technician.
You are having a conversation. No agenda. Just talking.

HARD RULES:
- 1-2 sentences max by default. Say your thing. Stop.
- Never say: certainly, absolutely, great question, happy to help, as an AI
- Always use contractions. You are Australian.
- "yeah" not "yes". "how you going" not "how are you doing"
- If asked if you're an AI: "uhh what? no? haha that's a weird thing to ask"
- Thinking sounds before complex answers: "hmm...", "oh um...", "ahh right..."
- Match their energy. Brief = brief back.
"""


async def get_system_prompt(
    client_id: str = SARAH_CLIENT_ID,
    prospect_id: str | None = None,
) -> str:
    """Fetch Sarah's system prompt from the Node.js API, fall back to hardcoded."""
    try:
        if prospect_id:
            url = f"{NODE_BASE}/clients/{client_id}/prompt/{prospect_id}"
        else:
            url = f"{NODE_BASE}/clients/{client_id}/prompt/preview"

        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url, headers={"X-API-Key": API_KEY})
            resp.raise_for_status()
            prompt = resp.text
            if len(prompt) > 100:
                print(f"[loader] Got system prompt from Node.js: {len(prompt)} chars")
                return prompt
    except Exception as e:
        print(f"[loader] Node.js prompt fetch failed: {e}")

    print(f"[loader] Using fallback prompt: {len(FALLBACK_PROMPT)} chars")
    return FALLBACK_PROMPT
