const ALLOWED_ORIGIN = "https://backbar-product-scanner.netlify.app";
const PHOTO_LOOKUP_MODEL = "claude-haiku-4-5-20251001";
const PHOTO_LOOKUP_TIMEOUT_MS = 30000;
const PHOTO_WEB_SEARCH_MAX_USES = 1;
const MAX_IMAGE_DATA_LENGTH = 8500000;

function text(value, maxLength = 6000) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}
function firstText(...values) {
  for (const value of values) {
    const result = text(value);
    if (result) return result;
  }
  return "";
}
function imageUrl(value) {
  const candidate = text(value, 1000);
  return /^https?:\/\//i.test(candidate) ? candidate : "";
}
function responseText(data) {
  const chunks = [];
  const content = Array.isArray(data?.content) ? data.content : [];
  for (const item of content) {
    if (typeof item?.text === "string") chunks.push(item.text);
  }
  return chunks.join("\n");
}
function parseJson(value) {
  const raw = text(value, 16000)
    .replace(/^[\u0060]{3}(?:json)?\s*/i, "")
    .replace(/\s*[\u0060]{3}$/i, "")
    .trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  }
}
function citationUrls(data) {
  const urls = [];
  const seen = new Set();
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value.url === "string" && /^https?:\/\//i.test(value.url)) {
      const url = value.url.trim();
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
    Object.values(value).forEach(child => {
      if (child && typeof child === "object") visit(child);
    });
  }
  visit(data);
  return urls.slice(0, 8);
}
function normalizeProduct(data, barcode, urls) {
  if (!data || data.found !== true) return null;
  const barcodeMatch = firstText(data.barcode_match, data.barcodeMatch, data.identity_match, "unknown").toLowerCase();
  if (barcode && /conflict|mismatch|different|not[_ -]?match/.test(barcodeMatch)) return null;
  const name = firstText(data.name, data.product_name, data.title);
  if (!name) return null;
  const sourceUrls = Array.from(new Set([
    ...(Array.isArray(data.source_urls) ? data.source_urls : []),
    ...(Array.isArray(data.sourceUrls) ? data.sourceUrls : []),
    ...urls
  ].map(imageUrl).filter(Boolean))).slice(0, 8);
  const confidence = ["high","medium","low"].includes(String(data.confidence).toLowerCase())
    ? String(data.confidence).toLowerCase()
    : "low";
  return {
    barcode:barcode || "",
    name,
    brand:firstText(data.brand),
    type:firstText(data.type, data.product_type, data.category),
    variant:firstText(data.variant, data.flavour, data.flavor),
    volume:firstText(data.volume, data.size),
    abv:firstText(data.abv, data.alcohol_strength, data.alcohol),
    packaging:firstText(data.packaging),
    country:firstText(data.country, data.origin),
    category:firstText(data.category, data.product_type),
    description:firstText(data.description),
    source:"AI photo recognition",
    sourceRecordUrl:firstText(sourceUrls[0]),
    sourceImageUrl:"",
    sourceUrls,
    matchConfidence:confidence,
    barcodeMatch:barcodeMatch,
    evidence:firstText(data.evidence, "Identified from the uploaded product image."),
    scope:firstText(data.scope, "unknown")
  };
}
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers:{
      "content-type":"application/json; charset=utf-8",
      "cache-control":"no-store",
      "access-control-allow-origin":ALLOWED_ORIGIN,
      vary:"Origin"
    }
  });
}
function location() {
  const country = text(process.env.ANTHROPIC_BARCODE_COUNTRY || "ZA", 2).toUpperCase();
  return {
    type:"approximate",
    country:/^[A-Z]{2}$/.test(country) ? country : "ZA",
    timezone:text(process.env.ANTHROPIC_BARCODE_TIMEZONE || "Africa/Johannesburg", 80)
  };
}

export default async function photoLookup(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status:204,
      headers:{
        "access-control-allow-origin":ALLOWED_ORIGIN,
        "access-control-allow-methods":"POST, OPTIONS",
        "access-control-allow-headers":"content-type"
      }
    });
  }
  if (request.method !== "POST") return jsonResponse(405, { ok:false, error:"POST required" });
  const origin = request.headers.get("origin");
  if (origin && origin !== ALLOWED_ORIGIN) return jsonResponse(403, { ok:false, error:"Origin not allowed" });

  const apiKey = text(process.env.ANTHROPIC_API_KEY, 300);
  if (!apiKey) return jsonResponse(503, { ok:false, error:"AI photo lookup is not configured" });

  let payload;
  try { payload = await request.json(); } catch { return jsonResponse(400, { ok:false, error:"Valid JSON is required" }); }
  const imageDataUrl = text(payload?.imageDataUrl, MAX_IMAGE_DATA_LENGTH);
  const imageMatch = imageDataUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!imageMatch) return jsonResponse(400, { ok:false, error:"A resized JPEG, PNG, or WebP image is required" });
  if (imageDataUrl.length > MAX_IMAGE_DATA_LENGTH) return jsonResponse(413, { ok:false, error:"Image is too large" });

  const barcode = text(payload?.barcode, 80);
  const expectedRecord = payload?.barcodeProduct && typeof payload.barcodeProduct === "object"
    ? {
        name:firstText(payload.barcodeProduct.name),
        brand:firstText(payload.barcodeProduct.brand),
        variant:firstText(payload.barcodeProduct.variant),
        volume:firstText(payload.barcodeProduct.volume),
        type:firstText(payload.barcodeProduct.type),
        source:firstText(payload.barcodeProduct.source)
      }
    : null;
  const mediaType = imageMatch[1].toLowerCase() === "image/jpg" ? "image/jpeg" : imageMatch[1].toLowerCase();
  const imageBase64 = imageMatch[2].replace(/\s+/g, "");
  const prompt = [
    "You are the photo fallback for a hospitality liquid-stock inventory app.",
    "Inspect the supplied product photo and identify the exact beverage or liquid product shown on the label.",
    "Prioritize spirits, wine, beer, cider, soft drinks/cooldrinks, water, juice, mixers, energy drinks, syrups, and shots.",
    "Read visible label text carefully. Use web search once when it can verify the product name, flavour, size, or brand.",
    "If a barcode is supplied, use it as a search hint but do not assume the barcode result is correct.",
    barcode ? "Barcode hint from the scanner: " + barcode : "No barcode was available.",
    "Treat the barcode as the primary identity. Use the photo to confirm the visible label, brand, product name, variant, and size.",
    expectedRecord
      ? "Unverified barcode lookup record for cross-checking only: " + JSON.stringify(expectedRecord)
      : "No earlier barcode lookup record is available.",
    "If the visible label conflicts with the exact barcode evidence or the supplied lookup record, return found:false and set barcode_match to conflict.",
    "Do not identify a product from a similar-looking package. If uncertain, return found:false.",
    "Do not guess missing fields. Return empty strings for fields not visible or verified.",
    "Return only one JSON object with no Markdown in this shape:",
    '{"found":true,"scope":"in_scope|out_of_scope|unknown","barcode_match":"exact|consistent|conflict|unknown","name":"","brand":"","type":"","variant":"","volume":"","abv":"","packaging":"","country":"","category":"","description":"","source_urls":[],"confidence":"high|medium|low|none","evidence":""}',
    "Set found:true only when the label or a cited web source provides enough evidence for a useful inventory record.",
    "If the image is not a product label or cannot be identified confidently, return found:false, scope:unknown, confidence:none."
  ].join("\n");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PHOTO_LOOKUP_TIMEOUT_MS);
  const startedAt = Date.now();
  const model = process.env.ANTHROPIC_BARCODE_MODEL || PHOTO_LOOKUP_MODEL;
  const tools = [{
    type:"web_search_20250305",
    name:"web_search",
    max_uses:PHOTO_WEB_SEARCH_MAX_USES,
    user_location:location()
  }];
  const messages = [{
    role:"user",
    content:[
      { type:"image", source:{ type:"base64", media_type:mediaType, data:imageBase64 } },
      { type:"text", text:prompt }
    ]
  }];

  try {
    let response = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      signal:controller.signal,
      headers:{
        accept:"application/json",
        "content-type":"application/json",
        "x-api-key":apiKey,
        "anthropic-version":"2023-06-01"
      },
      body:JSON.stringify({ model, max_tokens:800, tools, messages })
    });
    let raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
    let continuations = 0;
    while (response.ok && data?.stop_reason === "pause_turn" && Array.isArray(data.content) && continuations < 1) {
      messages.push({ role:"assistant", content:data.content });
      continuations++;
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        signal:controller.signal,
        headers:{
          accept:"application/json",
          "content-type":"application/json",
          "x-api-key":apiKey,
          "anthropic-version":"2023-06-01"
        },
        body:JSON.stringify({ model, max_tokens:800, tools, messages })
      });
      raw = await response.text();
      try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
    }

    const parsed = parseJson(responseText(data));
    const urls = citationUrls(data);
    const product = response.ok ? normalizeProduct(parsed, barcode, urls) : null;
    return jsonResponse(response.ok ? 200 : response.status || 502, {
      ok:true,
      found:!!product,
      product,
      sources:[{
        source:"AI photo recognition",
        status:response.status,
        ok:response.ok,
        configured:true,
        found:!!product,
        model,
        webSearchMaxUses:PHOTO_WEB_SEARCH_MAX_USES,
        pauseContinuations:continuations,
        citationUrlCount:urls.length,
        error:response.ok ? (parsed ? null : "invalid_ai_json") : text(data?.error?.message || raw, 320),
        elapsedMs:Date.now()-startedAt
      }]
    });
  } catch(error) {
    return jsonResponse(502, {
      ok:true,
      found:false,
      product:null,
      sources:[{
        source:"AI photo recognition",
        status:0,
        ok:false,
        configured:true,
        found:false,
        model,
        webSearchMaxUses:PHOTO_WEB_SEARCH_MAX_USES,
        error:text(error?.message || error, 320),
        elapsedMs:Date.now()-startedAt
      }]
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export const config = {
  path:"/.netlify/functions/photo-lookup"
};
