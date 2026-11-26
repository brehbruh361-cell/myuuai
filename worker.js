// MyuuAI – Cloudflare Worker backend
// Secrets (wrangler secret put ...):
//   MAGIC_HOUR_API_KEY   (wajib)  – video, image, voice, music
//   ELEVENLABS_API_KEY   (opsional) – sound effects
//   APP_ACCESS_TOKEN     (disarankan) – token yang diisi di Settings aplikasi agar Worker tidak dipakai orang lain
// Binding: [ai] binding = "AI" – untuk Auto Subtitle (Whisper)
// Vars: ALLOWED_ORIGINS = "*" atau "https://domain-kamu.com,https://domain-lain.com"

const MH = "https://api.magichour.ai";
const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
const VIDEO_MODELS = ["ltx-2.5", "seedance-2.0-fast", "wan-3.0", "kling-2.6", "default"];
const DOWNLOAD_HOST_SUFFIXES = ["magichour.ai", "cloudfront.net"];

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function corsHeaders(env, origin) {
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean);
  const allowOrigin = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : allowed[0] || "";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-MyuuAI-Token",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function checkAuth(request, env) {
  if (!env.APP_ACCESS_TOKEN) return;
  const token = request.headers.get("X-MyuuAI-Token") || "";
  if (!safeEqual(token, env.APP_ACCESS_TOKEN)) {
    throw new HttpError(401, "Access Token salah atau belum diisi di Settings aplikasi.", "invalid_app_token");
  }
}

function requireMagicHour(env) {
  if (!env.MAGIC_HOUR_API_KEY) {
    throw new HttpError(501, "MAGIC_HOUR_API_KEY belum disimpan sebagai Secret di Worker.", "missing_magic_hour_key");
  }
}

async function mh(env, path, init = {}) {
  requireMagicHour(env);
  const res = await fetch(MH + path, {
    ...init,
    headers: {
      Authorization: "Bearer " + env.MAGIC_HOUR_API_KEY,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text.slice(0, 300) };
  }
  if (!res.ok) {
    const prefix = {
      401: "API key Magic Hour tidak valid.",
      402: "Kredit Magic Hour tidak cukup atau paket belum mendukung fitur ini.",
      404: "Resource Magic Hour tidak ditemukan.",
      422: "Parameter tidak didukung model yang dipilih.",
      429: "Batas permintaan Magic Hour tercapai.",
    }[res.status] || "Magic Hour error.";
    throw new HttpError(res.status, `${prefix} ${data.message || ""}`.trim(), data.code);
  }
  return data;
}

function extensionOf(file) {
  const fromName = (file.name || "").split(".").pop().toLowerCase();
  if (fromName && fromName.length <= 5 && /^[a-z0-9]+$/.test(fromName)) return fromName;
  const map = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/heic": "heic",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp4": "m4a", "audio/ogg": "ogg",
  };
  return map[file.type] || "png";
}

async function uploadAsset(env, file, type) {
  if (!(file instanceof File) || file.size === 0) throw new HttpError(400, "File " + type + " tidak valid.");
  const data = await mh(env, "/v1/files/upload-urls", {
    method: "POST",
    body: JSON.stringify({ items: [{ type, extension: extensionOf(file) }] }),
  });
  const item = data.items && data.items[0];
  if (!item) throw new HttpError(502, "Magic Hour tidak mengembalikan upload URL.");
  const put = await fetch(item.upload_url, { method: "PUT", body: await file.arrayBuffer() });
  if (!put.ok) throw new HttpError(502, "Upload file ke Magic Hour gagal (HTTP " + put.status + ").");
  return item.file_path;
}

function str(form, key, fallback = "") {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : fallback;
}

async function createVideo(request, env) {
  const form = await request.formData();
  const prompt = str(form, "prompt");
  const mode = str(form, "mode", "text");
  const model = VIDEO_MODELS.includes(str(form, "model")) ? str(form, "model") : "ltx-2.5";
  const duration = Math.round(Number(str(form, "duration", "5")));
  const resolution = str(form, "resolution", "480p");
  const supportedResolutions = {
    "ltx-2.5": ["480p", "720p", "1080p"],
    "seedance-2.0-fast": ["480p", "720p"],
    "wan-3.0": ["480p", "720p", "1080p"],
    "kling-2.6": ["720p", "1080p"],
    "default": ["480p", "720p"]
  };
  const audio = str(form, "audio") === "true";
  if (!Number.isFinite(duration) || duration < 1 || duration > 60) throw new HttpError(400, "Durasi video tidak valid.");
  if (!(supportedResolutions[model] || supportedResolutions.default).includes(resolution)) {
    throw new HttpError(422, `Resolusi ${resolution} tidak didukung model ${model}.`);
  }

  if (mode === "reference") {
    const image = form.get("image");
    if (!(image instanceof File)) throw new HttpError(400, "Gambar referensi wajib untuk Image to Video.");
    const filePath = await uploadAsset(env, image, "image");
    const body = {
      name: "MyuuAI Image to Video",
      end_seconds: duration,
      model,
      resolution,
      audio,
      assets: { image_file_path: filePath },
      ...(prompt ? { style: { prompt } } : {}),
    };
    const r = await mh(env, "/v1/image-to-video", { method: "POST", body: JSON.stringify(body) });
    return { success: true, id: r.id, job_type: "video", credits_charged: r.credits_charged };
  }

  if (!prompt) throw new HttpError(400, "Prompt video wajib diisi.");
  const aspect = ["16:9", "9:16", "1:1"].includes(str(form, "aspect_ratio")) ? str(form, "aspect_ratio") : "16:9";
  const body = { name: "MyuuAI Text to Video", end_seconds: duration, aspect_ratio: aspect, model, resolution, audio, style: { prompt } };
  const r = await mh(env, "/v1/text-to-video", { method: "POST", body: JSON.stringify(body) });
  return { success: true, id: r.id, job_type: "video", credits_charged: r.credits_charged };
}

async function createImage(request, env) {
  const form = await request.formData();
  const prompt = str(form, "prompt");
  if (!prompt) throw new HttpError(400, "Prompt gambar wajib diisi.");
  const aspect = str(form, "aspect_ratio", "1:1");
  const image = form.get("image");
  let r;
  if (str(form, "mode") === "reference" && image instanceof File) {
    const filePath = await uploadAsset(env, image, "image");
    r = await mh(env, "/v1/ai-image-editor", {
      method: "POST",
      body: JSON.stringify({
        name: "MyuuAI Image Reference",
        image_count: 1,
        aspect_ratio: aspect,
        style: { prompt },
        assets: { image_file_paths: [filePath] },
      }),
    });
  } else {
    r = await mh(env, "/v1/ai-image-generator", {
      method: "POST",
      body: JSON.stringify({ name: "MyuuAI Image", image_count: 1, aspect_ratio: aspect, style: { prompt } }),
    });
  }
  return { success: true, id: r.id, job_type: "image", credits_charged: r.credits_charged };
}

async function createVoice(request, env) {
  const form = await request.formData();
  const text = str(form, "text");
  const voice = str(form, "voice_id");
  if (!text) throw new HttpError(400, "Teks dialog wajib diisi.");
  if (text.length > 5000) throw new HttpError(400, "Teks maksimal 5000 karakter.");
  if (!voice) throw new HttpError(400, "Voice ID belum dipilih untuk karakter ini.");
  const r = await mh(env, "/v1/ai-voice-generator", {
    method: "POST",
    body: JSON.stringify({ name: "MyuuAI Voice " + (str(form, "character_name") || ""), style: { prompt: text, voice_name: voice } }),
  });
  return { success: true, id: r.id, job_type: "audio", credits_charged: r.credits_charged };
}

async function createMusic(request, env) {
  const form = await request.formData();
  const prompt = str(form, "prompt");
  if (!prompt) throw new HttpError(400, "Deskripsi musik wajib diisi.");
  const mood = str(form, "mood");
  const duration = Math.min(300, Math.max(15, Math.round(Number(str(form, "duration", "30"))) || 30));
  const r = await mh(env, "/v1/ai-music-generator", {
    method: "POST",
    body: JSON.stringify({
      name: "MyuuAI Music",
      duration,
      style: { prompt: mood ? `${mood} mood. ${prompt}` : prompt, instrumental: str(form, "instrumental") === "true" },
    }),
  });
  return { success: true, id: r.id, job_type: "audio", credits_charged: r.credits_charged };
}

async function createSfx(request, env, cors) {
  if (!env.ELEVENLABS_API_KEY) {
    throw new HttpError(501, "Magic Hour tidak menyediakan API efek suara. Tambahkan Secret ELEVENLABS_API_KEY di Worker untuk mengaktifkan fitur ini.", "sfx_not_configured");
  }
  const form = await request.formData();
  const prompt = str(form, "prompt");
  if (!prompt) throw new HttpError(400, "Deskripsi efek suara wajib diisi.");
  const duration = Number(str(form, "duration", ""));
  const body = { text: prompt };
  if (Number.isFinite(duration) && duration > 0) body.duration_seconds = Math.min(22, Math.max(0.5, duration));
  const res = await fetch("https://api.elevenlabs.io/v1/sound-generation", {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new HttpError(res.status, "ElevenLabs error: " + t.slice(0, 300));
  }
  return new Response(res.body, { status: 200, headers: { ...cors, "Content-Type": "audio/mpeg" } });
}

async function transcribe(request, env) {
  if (!env.AI) {
    throw new HttpError(501, "Binding Workers AI (AI) belum ditambahkan di wrangler.toml, jadi subtitle otomatis belum aktif.", "ai_binding_missing");
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body.audio_base64 !== "string" || body.audio_base64.length < 100) {
    throw new HttpError(400, "Data audio tidak valid.");
  }
  if (body.audio_base64.length > 20 * 1024 * 1024) throw new HttpError(413, "Potongan audio terlalu besar.");
  const input = { audio: body.audio_base64, task: "transcribe", vad_filter: true };
  if (typeof body.language === "string" && /^[a-z]{2}$/.test(body.language)) input.language = body.language;
  const r = await env.AI.run(WHISPER_MODEL, input);
  const segments = Array.isArray(r.segments)
    ? r.segments.map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || "").trim() }))
    : [];
  return { success: true, text: r.text || "", segments, language: r.transcription_info?.language || null };
}

async function getStatus(url, env) {
  const type = url.searchParams.get("type");
  const id = url.searchParams.get("id");
  if (!["video", "image", "audio"].includes(type)) throw new HttpError(400, "Parameter type harus video, image, atau audio.");
  if (!id || !/^[\w-]{3,80}$/.test(id)) throw new HttpError(400, "Job ID tidak valid.");
  const r = await mh(env, `/v1/${type}-projects/${encodeURIComponent(id)}`);
  const downloads = Array.isArray(r.downloads) ? r.downloads : [];
  return {
    success: true,
    id: r.id,
    status: r.status,
    url: downloads[0]?.url || null,
    downloads,
    error: r.error?.message || null,
    credits_charged: r.credits_charged ?? null,
  };
}

async function listVoices(url, env) {
  const q = new URLSearchParams({ limit: "100" });
  const cursor = url.searchParams.get("cursor");
  if (cursor) q.set("cursor", cursor);
  const r = await mh(env, "/v1/voices?" + q.toString());
  return { success: true, voices: r.voices || [], next_cursor: r.next_cursor || null };
}

async function proxyDownload(url, cors) {
  const target = url.searchParams.get("url");
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    throw new HttpError(400, "URL unduhan tidak valid.");
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = parsed.protocol === "https:" && DOWNLOAD_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
  if (!allowed) throw new HttpError(403, "Host unduhan tidak diizinkan.");
  const res = await fetch(parsed.toString());
  if (!res.ok) throw new HttpError(res.status, "Gagal mengunduh hasil (link mungkin sudah kedaluwarsa).");
  return new Response(res.body, {
    status: 200,
    headers: { ...cors, "Content-Type": res.headers.get("Content-Type") || "application/octet-stream" },
  });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request.headers.get("Origin") || "");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/api/health") {
        return json({
          success: true,
          name: "MyuuAI Worker",
          services: {
            magic_hour: Boolean(env.MAGIC_HOUR_API_KEY),
            elevenlabs_sfx: Boolean(env.ELEVENLABS_API_KEY),
            workers_ai_subtitle: Boolean(env.AI),
          },
          auth_required: Boolean(env.APP_ACCESS_TOKEN),
        }, 200, cors);
      }
      checkAuth(request, env);
      const post = request.method === "POST";
      if (post && path === "/api/video") return json(await createVideo(request, env), 200, cors);
      if (post && path === "/api/image") return json(await createImage(request, env), 200, cors);
      if (post && path === "/api/voice") return json(await createVoice(request, env), 200, cors);
      if (post && path === "/api/music") return json(await createMusic(request, env), 200, cors);
      if (post && path === "/api/sfx") return await createSfx(request, env, cors);
      if (post && path === "/api/subtitle") return json(await transcribe(request, env), 200, cors);
      if (!post && path === "/api/status") return json(await getStatus(url, env), 200, cors);
      if (!post && path === "/api/voices") return json(await listVoices(url, env), 200, cors);
      if (!post && path === "/api/download") return await proxyDownload(url, cors);
      if (!post && !path.startsWith("/api/") && env.ASSETS) {
  return env.ASSETS.fetch(request);
      }throw new HttpError(404, "Route " + request.method + " " + path + " tidak ada di Worker.");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      return json({ success: false, error: e.message || "Terjadi kesalahan di Worker.", code: e.code || null }, status, cors);
    }
  },
};
