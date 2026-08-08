import { getStore } from "@netlify/blobs";

const ALLOWED_ORIGIN = "https://backbar-product-scanner.netlify.app";
const STUDIO_JOB_STORE = "studio-image-jobs";
const STUDIO_JOB_PREFIX = "jobs/";
// Netlify synchronous functions have a hard 60-second execution limit and a
// 6 MB buffered request/response limit. Keep a safety margin for the API call
// and reject oversized source photos before the platform rejects the request.
const IMAGE_TIMEOUT_MS = 55000;
const MAX_IMAGE_DATA_LENGTH = 4500000;
const SUPPORTED_MODELS = new Set([
  "gpt-image-1.5",
  "gpt-image-1",
  "gpt-image-1-mini",
  "chatgpt-image-latest"
]);

function text(value, maxLength = 6000) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeJobId(value) {
  return text(value, 120)
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 96);
}

function jobKey(jobId) {
  return STUDIO_JOB_PREFIX + jobId + ".json";
}

async function readStudioJob(jobId) {
  if (!jobId) return null;
  try {
    return await getStore(STUDIO_JOB_STORE).get(jobKey(jobId), {
      consistency: "strong",
      type: "json"
    });
  } catch (error) {
    console.warn("[studio-image] job read failed", JSON.stringify({
      jobId,
      error: redactSecrets(error?.message || error)
    }));
    return null;
  }
}

async function writeStudioJob(jobId, record) {
  if (!jobId) return false;
  try {
    await getStore(STUDIO_JOB_STORE).setJSON(jobKey(jobId), record, {
      metadata: {
        status: String(record?.status || "unknown"),
        updatedAt: new Date().toISOString()
      }
    });
    return true;
  } catch (error) {
    console.error("[studio-image] job write failed", JSON.stringify({
      jobId,
      status:record?.status || null,
      error: redactSecrets(error?.message || error)
    }));
    return false;
  }
}

function redactSecrets(value) {
  return text(value, 320)
    .replace(/sk-ant-[A-Za-z0-9_-]+/gi, "[redacted]")
    .replace(/sk-proj-[A-Za-z0-9_-]+/gi, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/gi, "[redacted]");
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

function productDetails(input) {
  const value = input && typeof input === "object" ? input : {};
  return {
    barcode:text(value.barcode, 14).replace(/[^0-9]/g, ""),
    name:text(value.name, 180),
    brand:text(value.brand, 100),
    variant:text(value.variant, 120),
    volume:text(value.volume, 80),
    type:text(value.type, 100),
    abv:text(value.abv, 40),
    packaging:text(value.packaging, 80),
    description:text(value.description, 260)
  };
}

function studioPrompt(product, barcode) {
  const details = [
    product.brand && "Brand: " + product.brand,
    product.name && "Product name: " + product.name,
    product.variant && "Variant/flavour: " + product.variant,
    product.volume && "Bottle or pack size: " + product.volume,
    product.type && "Product type: " + product.type,
    product.abv && "Alcohol strength: " + product.abv,
    product.packaging && "Packaging: " + product.packaging,
    barcode && "Verified barcode: " + barcode
  ].filter(Boolean).join("; ");

  return [
    "Create a new photorealistic commercial product-studio photograph of the exact liquid product shown in the supplied source image.",
    "This is a true AI studio recreation, not background removal and not a simple crop.",
    "Use the source image as the strict visual identity reference, and use the verified product details below as additional constraints.",
    "Preserve the exact product identity: bottle silhouette, proportions, cap, liquid level, label artwork, logo, colours, flavour wording, and visible packaging details.",
    "Do not invent a similar product, substitute another size, or redesign the label.",
    "Scene: seamless pure white studio background and white floor, no room, no props, no hands, no packaging beside the product.",
    "Composition: one bottle only, upright, front-facing, centered, full product visible, square catalog framing with generous even margins.",
    "Lighting: high-end beverage product photography, soft diffused studio lights, clean controlled highlights, crisp edges, balanced exposure, subtle realistic contact shadow beneath the bottle.",
    "Materials: retain believable transparent plastic or glass, liquid, reflections, cap texture, label texture, and natural bottle contours.",
    "Do not add any text, badge, watermark, border, decorative graphic, or unverified claim.",
    "Do not change or hallucinate label text. If text is visible, reproduce it exactly as shown in the source.",
    "Verified product details: " + details
  ].join("\n");
}

export default async function studioImage(request) {
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

  let payload;
  try { payload = await request.json(); } catch { return jsonResponse(400, { ok:false, error:"Valid JSON is required" }); }

  const jobId = normalizeJobId(payload?.jobId);
  const existingJob = await readStudioJob(jobId);
  if (existingJob?.status === "completed" && existingJob.imageDataUrl) {
    console.info("[studio-image] returning cached job result", JSON.stringify({ jobId }));
    return jsonResponse(200, existingJob);
  }
  if (existingJob?.status === "processing") {
    return jsonResponse(409, {
      ok:false,
      code:"STUDIO_JOB_IN_PROGRESS",
      status:"processing",
      jobId,
      error:"This studio image request is already processing. Retrieve its result from the status endpoint."
    });
  }
  if (existingJob?.status === "failed") {
    return jsonResponse(502, existingJob);
  }

  const apiKey = text(process.env.OPENAI_API_KEY, 300);
  if (!apiKey) {
    return jsonResponse(503, {
      ok:false,
      error:"AI studio image generation is not configured. Add OPENAI_API_KEY in Netlify."
    });
  }
  if (/^sk-ant-/i.test(apiKey)) {
    console.error("[studio-image] rejected wrong provider key", JSON.stringify({
      provider:"anthropic",
      expected:"openai"
    }));
    return jsonResponse(503, {
      ok:false,
      code:"WRONG_PROVIDER_KEY",
      error:"OPENAI_API_KEY contains an Anthropic/Claude key. Keep the Claude key in ANTHROPIC_API_KEY for product lookup, and set OPENAI_API_KEY to a valid OpenAI API key for studio image generation."
    });
  }

  const sourceImageDataUrl = text(payload?.sourceImageDataUrl, MAX_IMAGE_DATA_LENGTH);
  const imageMatch = sourceImageDataUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!imageMatch) return jsonResponse(400, { ok:false, error:"A resized JPEG, PNG, or WebP source photo is required" });
  if (sourceImageDataUrl.length > MAX_IMAGE_DATA_LENGTH) return jsonResponse(413, { ok:false, error:"Source photo is too large" });

  const product = productDetails(payload?.product);
  const barcode = text(payload?.barcode || product.barcode, 14).replace(/[^0-9]/g, "");
  if (!product.name) {
    console.warn("[studio-image] rejected: missing verified product name");
    return jsonResponse(400, { ok:false, error:"A verified product name is required before studio generation" });
  }

  const configuredModel = text(process.env.OPENAI_STUDIO_IMAGE_MODEL, 80);
  const model = SUPPORTED_MODELS.has(configuredModel) ? configuredModel : "gpt-image-1.5";
  if (jobId) {
    const claimed = await getStore(STUDIO_JOB_STORE).setJSON(jobKey(jobId), {
      ok:true,
      status:"processing",
      jobId,
      barcode:barcode || null,
      model,
      startedAt:new Date().toISOString()
    }, {
      onlyIfNew:true,
      metadata:{ status:"processing", barcode:barcode || "" }
    });
    if (claimed && claimed.modified === false) {
      const current = await readStudioJob(jobId);
      if (current?.status === "completed" && current.imageDataUrl) return jsonResponse(200, current);
      return jsonResponse(409, {
        ok:false,
        code:"STUDIO_JOB_IN_PROGRESS",
        status:current?.status || "processing",
        jobId,
        error:"This studio image request is already processing. Retrieve its result from the status endpoint."
      });
    }
  }
  const mediaType = imageMatch[1].toLowerCase() === "image/jpg" ? "image/jpeg" : imageMatch[1].toLowerCase();
  const imageBytes = Buffer.from(imageMatch[2].replace(/\s+/g, ""), "base64");
  const form = new FormData();
  form.append("model", model);
  form.append("image[]", new Blob([imageBytes], { type:mediaType }), "source-bottle.jpg");
  form.append("prompt", studioPrompt(product, barcode));
  form.append("background", "opaque");
  form.append("input_fidelity", "high");
  form.append("quality", "high");
  form.append("size", "1024x1024");
  form.append("output_format", "jpeg");
  form.append("output_compression", "92");
  form.append("n", "1");
  form.append("moderation", "auto");
  form.append("user", "backbar-scanner");
  console.info("[studio-image] request", JSON.stringify({ model, jobId:jobId || null, barcode:barcode || null, sourceBytes:imageBytes.length }));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch("https://api.openai.com/v1/images/edits", {
      method:"POST",
      headers:{ accept:"application/json", authorization:"Bearer " + apiKey },
      body:form,
      signal:controller.signal
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch {}
    if (!response.ok) {
      const requestId = text(response.headers.get("x-request-id"), 120);
      const providerError = response.status === 401
        ? "OpenAI rejected OPENAI_API_KEY. Replace it with a valid OpenAI API key; a Claude/Anthropic key cannot generate the studio image."
        : redactSecrets(data?.error?.message || "OpenAI image generation failed");
      console.error("[studio-image] OpenAI error", JSON.stringify({
        status:response.status,
        model,
        requestId:requestId || null,
        error:providerError,
        elapsedMs:Date.now() - startedAt
      }));
      const failure = {
        ok:false,
        status:"failed",
        jobId:jobId || null,
        code:response.status === 401 ? "OPENAI_AUTH_FAILED" : "OPENAI_IMAGE_REQUEST_FAILED",
        error:providerError,
        model,
        requestId:requestId || null,
        elapsedMs:Date.now() - startedAt
      };
      await writeStudioJob(jobId, failure);
      return jsonResponse(response.status || 502, failure);
    }
    const imageBase64 = text(data?.data?.[0]?.b64_json, 12000000).replace(/\s+/g, "");
    if (!imageBase64) {
      console.error("[studio-image] OpenAI returned no image", JSON.stringify({ model, elapsedMs:Date.now() - startedAt }));
      const failure = {
        ok:false,
        status:"failed",
        jobId:jobId || null,
        error:"The AI studio renderer returned no image",
        model
      };
      await writeStudioJob(jobId, failure);
      return jsonResponse(502, failure);
    }
    const result = {
      ok:true,
      status:"completed",
      jobId:jobId || null,
      imageDataUrl:"data:image/jpeg;base64," + imageBase64,
      model,
      quality:"high",
      inputFidelity:"high",
      size:"1024x1024",
      outputFormat:"jpeg",
      generated:true,
      elapsedMs:Date.now() - startedAt
    };
    console.info("[studio-image] success", JSON.stringify({ model, jobId:jobId || null, outputBytes:imageBase64.length, elapsedMs:Date.now() - startedAt }));
    await writeStudioJob(jobId, Object.assign({}, result, { completedAt:new Date().toISOString() }));
    return jsonResponse(200, result);
  } catch(error) {
    const timedOut = error?.name === "AbortError";
    console.error("[studio-image] request failed", JSON.stringify({
      model,
      timedOut,
      error:redactSecrets(error?.message || "The AI studio renderer could not be reached"),
      elapsedMs:Date.now() - startedAt
    }));
    const failure = {
      ok:false,
      status:"failed",
      jobId:jobId || null,
      error:timedOut
        ? "The AI studio renderer timed out. Please retry the studio image step."
        : redactSecrets(error?.message || "The AI studio renderer could not be reached"),
      model,
      elapsedMs:Date.now() - startedAt
    };
    await writeStudioJob(jobId, failure);
    return jsonResponse(timedOut ? 504 : 502, failure);
  } finally {
    clearTimeout(timeoutId);
  }
}

export const config = {
  path:"/.netlify/functions/studio-image"
};
