import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Ações:
//  - JSON {prompt, json}                    -> texto da IA (Groq gratuito ou Anthropic)
//  - JSON {action:"ice"}                    -> servidores STUN/TURN para a chamada
//  - multipart {action:"transcribe", audio} -> transcrição (Whisper no Groq)
const ALLOWED_ORIGINS = [
  "https://mateusdesleal-ops.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];
const MAX_PROMPT = 40000;
const PER_IP_PER_MIN = 60;
const PER_DAY = 8000;
const GROQ_MODELS = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "openai/gpt-oss-20b"];
const WHISPER_MODELS = ["whisper-large-v3", "whisper-large-v3-turbo"];
const STUN = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];

function cors(origin: string | null) {
  const ok = origin && ALLOWED_ORIGINS.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin! : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(origin), "Content-Type": "application/json" } });
}

async function rateLimited(ip: string) {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data } = await admin.rpc("nuance_ai_hit", { p_ip: ip });
    const row = Array.isArray(data) ? data[0] : data;
    return !!(row && (row.per_ip_min > PER_IP_PER_MIN || row.total_day > PER_DAY));
  } catch (_) { return false; }
}

function asList(x: unknown) { return !x ? [] : Array.isArray(x) ? x : [x]; }

async function iceServers() {
  // Cloudflare Realtime TURN (1.000 GB/mês grátis): secrets CF_TURN_KEY_ID e CF_TURN_API_TOKEN
  const kid = Deno.env.get("CF_TURN_KEY_ID"), tok = Deno.env.get("CF_TURN_API_TOKEN");
  if (kid && tok) {
    for (const path of ["credentials/generate-ice-servers", "credentials/generate"]) {
      try {
        const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${kid}/${path}`, {
          method: "POST", headers: { "Authorization": `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify({ ttl: 14400 }),
        });
        if (r.ok) {
          const d = await r.json();
          const list = asList(d.iceServers);
          if (list.length) return { iceServers: [...STUN, ...list], turn: true };
        } else {
          console.error("turn_error", path, r.status, (await r.text()).slice(0, 300));
          if (r.status !== 404) break;
        }
      } catch (e) { console.error("turn_error", String(e)); }
    }
  }
  // Open Relay / Metered (20 GB/mês grátis): secret METERED_TURN_URL = URL de credenciais com a apiKey,
  // ex.: https://SEUAPP.metered.live/api/v1/turn/credentials?apiKey=XXXX
  const mUrl = Deno.env.get("METERED_TURN_URL");
  if (mUrl) {
    try {
      const r = await fetch(mUrl);
      if (r.ok) { const list = asList(await r.json()); if (list.length) return { iceServers: [...STUN, ...list], turn: true }; }
      else console.error("metered_error", r.status, (await r.text()).slice(0, 300));
    } catch (e) { console.error("metered_error", String(e)); }
  }
  // TURN genérico (ex.: Metered): TURN_URLS (separadas por vírgula), TURN_USERNAME, TURN_CREDENTIAL
  const urls = Deno.env.get("TURN_URLS");
  if (urls) return { iceServers: [...STUN, { urls: urls.split(",").map((s) => s.trim()), username: Deno.env.get("TURN_USERNAME") ?? "", credential: Deno.env.get("TURN_CREDENTIAL") ?? "" }], turn: true };
  return { iceServers: STUN, turn: false };
}

async function transcribe(audio: File, prompt: string) {
  const key = Deno.env.get("GROQ_API_KEY");
  if (!key) return { status: 503, error: "missing_key" };
  let last = { status: 500, error: "upstream" };
  for (const model of WHISPER_MODELS) {
    const fd = new FormData();
    fd.append("file", audio, audio.name || "audio.webm");
    fd.append("model", model);
    fd.append("language", "pt");
    fd.append("response_format", "json");
    fd.append("temperature", "0");
    if (prompt) fd.append("prompt", prompt.slice(0, 800));
    const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST", headers: { "Authorization": `Bearer ${key}` }, body: fd });
    if (r.ok) { const d = await r.json(); return { text: String(d.text ?? "").trim() }; }
    const t = await r.text();
    console.error("whisper_error", model, r.status, t.slice(0, 300));
    last = { status: r.status, error: r.status === 429 ? "rate_limited" : r.status === 401 ? "bad_key" : "upstream" };
    if (!(r.status === 404 || (r.status === 400 && /model/i.test(t)))) break;
  }
  return last;
}

async function callAnthropic(key: string, system: string, prompt: string, maxTokens: number) {
  const model = Deno.env.get("NUANCE_MODEL") ?? "claude-sonnet-5-5";
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) return { status: r.status, err: await r.text() };
  const out = await r.json();
  return { text: (out.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("") };
}

async function callGroq(key: string, system: string, prompt: string, maxTokens: number, wantJson: boolean) {
  const custom = Deno.env.get("NUANCE_MODEL");
  const models = custom ? [custom, ...GROQ_MODELS.filter((m) => m !== custom)] : GROQ_MODELS;
  let last = { status: 500, err: "no_model" } as { status: number; err: string };
  for (const model of models) {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: maxTokens, temperature: 0.4,
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
        ...(wantJson ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    if (r.ok) { const out = await r.json(); return { text: out.choices?.[0]?.message?.content ?? "" }; }
    last = { status: r.status, err: await r.text() };
    if (!(r.status === 404 || (r.status === 400 && /model/i.test(last.err)))) break;
  }
  return last;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "method" }, 405, origin);
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return json({ error: "origin_not_allowed" }, 403, origin);
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "?";
  const ctype = req.headers.get("content-type") ?? "";

  // transcrição (multipart)
  if (ctype.includes("multipart/form-data")) {
    let fd: FormData; try { fd = await req.formData(); } catch { return json({ error: "bad_form" }, 400, origin); }
    const audio = fd.get("audio");
    if (!(audio instanceof File) || audio.size < 1000 || audio.size > 6_000_000) return json({ error: "bad_audio" }, 400, origin);
    if (await rateLimited(ip)) return json({ error: "rate_limited" }, 429, origin);
    const r = await transcribe(audio, String(fd.get("prompt") ?? ""));
    if ("text" in r) return json({ text: r.text }, 200, origin);
    return json({ error: r.error }, r.status === 429 ? 429 : r.status === 503 ? 503 : 502, origin);
  }

  let body: { prompt?: string; json?: boolean; max_tokens?: number; action?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400, origin); }

  if (body.action === "ice") return json(await iceServers(), 200, origin);

  const aKey = Deno.env.get("ANTHROPIC_API_KEY");
  const gKey = Deno.env.get("GROQ_API_KEY");
  const pref = (Deno.env.get("NUANCE_PROVIDER") ?? "").toLowerCase();
  const provider = pref === "groq" && gKey ? "groq" : pref === "anthropic" && aKey ? "anthropic" : aKey ? "anthropic" : gKey ? "groq" : null;
  if (!provider) return json({ error: "missing_key" }, 503, origin);

  const prompt = String(body.prompt ?? "");
  if (!prompt || prompt.length > MAX_PROMPT) return json({ error: "bad_prompt" }, 400, origin);
  if (await rateLimited(ip)) return json({ error: "rate_limited" }, 429, origin);

  const wantJson = !!body.json;
  const system = "Você é o assistente do Nuance, uma plataforma de entrevistas de emprego no Brasil. Responda sempre em português do Brasil." + (wantJson ? " Responda APENAS com um objeto JSON válido, sem texto antes ou depois e sem blocos de código." : "");
  const maxTokens = Math.min(Number(body.max_tokens) || 2000, 4000);
  const res = provider === "anthropic"
    ? await callAnthropic(aKey!, system, prompt, maxTokens)
    : await callGroq(gKey!, system, prompt, maxTokens, wantJson);

  if ("text" in res) return json({ text: res.text, provider }, 200, origin);
  console.error("provider_error", provider, res.status, String(res.err).slice(0, 500));
  const code = res.status === 429 ? "rate_limited" : res.status === 401 ? "bad_key" : "upstream";
  return json({ error: code, status: res.status }, res.status === 429 ? 429 : 502, origin);
});
