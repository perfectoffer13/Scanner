import { getStore } from "@netlify/blobs";

const ALLOWED_ORIGIN = "https://backbar-product-scanner.netlify.app";
const STUDIO_JOB_STORE = "studio-image-jobs";

function text(value, maxLength = 6000) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeJobId(value) {
  return text(value, 120)
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 96);
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type":"application/json; charset=utf-8",
      "cache-control":"no-store",
      "access-control-allow-origin":ALLOWED_ORIGIN,
      vary:"Origin"
    }
  });
}

export default async function studioImageStatus(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status:204,
      headers:{
        "access-control-allow-origin":ALLOWED_ORIGIN,
        "access-control-allow-methods":"GET, OPTIONS",
        "access-control-allow-headers":"content-type"
      }
    });
  }
  if (request.method !== "GET") return jsonResponse(405, { ok:false, error:"GET required" });
  const origin = request.headers.get("origin");
  if (origin && origin !== ALLOWED_ORIGIN) return jsonResponse(403, { ok:false, error:"Origin not allowed" });

  const jobId = normalizeJobId(new URL(request.url).searchParams.get("jobId"));
  if (!jobId) return jsonResponse(400, { ok:false, error:"jobId is required" });

  try {
    const record = await getStore(STUDIO_JOB_STORE).get("jobs/" + jobId + ".json", {
      consistency:"strong",
      type:"json"
    });
    if (!record) return jsonResponse(200, { ok:true, status:"pending", jobId });
    return jsonResponse(200, Object.assign({}, record, { jobId }));
  } catch (error) {
    console.error("[studio-image-status] read failed", JSON.stringify({
      jobId,
      error:text(error?.message || error, 300)
    }));
    return jsonResponse(503, {
      ok:false,
      status:"unavailable",
      jobId,
      error:"The studio image result store is temporarily unavailable."
    });
  }
}

export const config = {
  path:"/.netlify/functions/studio-image-status"
};
