const ALLOWED_ORIGIN = "https://backbar-product-scanner.netlify.app";
const DEFAULT_REPOSITORY = "perfectoffer13/Scanner";
const DEFAULT_BRANCH = "main";
const INVENTORY_PATH = "data/inventory/inventory.json";
const MAX_BODY_CHARS = 4500000;
const MAX_IMAGE_DATA_LENGTH = 4000000;
const MAX_ITEMS = 10;
const INVENTORY_SCHEMA_VERSION = 2;
const STUDIO_ASSET_VERSION = "studio-v2-ai";
const STUDIO_IMAGE_WIDTH = 1000;
const STUDIO_IMAGE_HEIGHT = 1000;
const GITHUB_API_VERSION = "2022-11-28";

function text(value, maxLength = 400) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function response(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": ALLOWED_ORIGIN,
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST, OPTIONS",
      vary: "Origin",
    },
  });
}

function githubUrl(repository, path) {
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return "https://api.github.com/repos/" + repository + "/contents/" + encodedPath;
}

function githubHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: "Bearer " + token,
    "content-type": "application/json",
    "x-github-api-version": GITHUB_API_VERSION,
  };
}

async function githubRequest(url, token, options = {}) {
  const requestOptions = Object.assign({}, options, {
    headers: Object.assign({}, githubHeaders(token), options.headers || {}),
  });
  const result = await fetch(url, requestOptions);
  const raw = await result.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (!result.ok) {
    const error = new Error(
      text(data?.message || raw || "GitHub request failed", 300),
    );
    error.status = result.status;
    throw error;
  }
  return data;
}

function getConfig() {
  const token = text(process.env.GITHUB_INVENTORY_TOKEN, 500);
  if (!token) {
    const error = new Error(
      "GitHub publishing is not configured. Add GITHUB_INVENTORY_TOKEN in Netlify.",
    );
    error.status = 503;
    throw error;
  }

  const repository = text(
    process.env.GITHUB_INVENTORY_REPOSITORY || DEFAULT_REPOSITORY,
    200,
  ).replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    const error = new Error("The GitHub inventory repository setting is invalid.");
    error.status = 500;
    throw error;
  }

  const branch = text(
    process.env.GITHUB_INVENTORY_BRANCH || DEFAULT_BRANCH,
    120,
  );
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
    const error = new Error("The GitHub inventory branch setting is invalid.");
    error.status = 500;
    throw error;
  }

  return { token, repository, branch };
}

async function readFile(config, path) {
  try {
    const data = await githubRequest(
      githubUrl(config.repository, path) + "?ref=" + encodeURIComponent(config.branch),
      config.token,
      { method: "GET" },
    );
    const encoded = String(data?.content || "").replace(/\s+/g, "");
    return {
      sha: text(data?.sha, 100),
      content: Buffer.from(encoded, "base64").toString("utf8"),
    };
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function writeTextFile(config, path, content, message, sha) {
  const body = {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch: config.branch,
  };
  if (sha) body.sha = sha;
  return githubRequest(githubUrl(config.repository, path), config.token, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

async function writeBase64File(config, path, content, message, sha) {
  const body = {
    message,
    content,
    branch: config.branch,
  };
  if (sha) body.sha = sha;
  return githubRequest(githubUrl(config.repository, path), config.token, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

function cleanId(value) {
  const normalized = text(value, 90)
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "item-" + Date.now();
}

function cleanGtin(value) {
  const digits = String(value ?? "").replace(/[^0-9]/g, "");
  return /^\d{8,14}$/.test(digits) ? digits : "";
}

function cleanList(value, maxItems = 8, maxLength = 600) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => text(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeSourceEvidence(value, barcode) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      barcode: barcode || "",
      sources: [],
      urls: [],
      notes: "",
    };
  }
  return {
    barcode: cleanGtin(value.barcode || barcode),
    sources: cleanList(value.sources, 8, 160),
    urls: cleanList(value.urls, 8, 1000).filter((url) => /^https?:\/\//i.test(url)),
    notes: text(value.notes, 500),
  };
}

function normalizeItem(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    const error = new Error("An inventory item is required.");
    error.status = 400;
    throw error;
  }

  const barcode = cleanGtin(input.gtin || input.barcode);
  const item = {
    id: cleanId(input.id || (barcode ? "gtin-" + barcode : input.name)),
    barcode,
    gtin: barcode,
    canonicalProductId: text(
      input.canonicalProductId || (barcode ? "gtin:" + barcode : ""),
      180,
    ),
    name: text(input.name, 240),
    brand: text(input.brand, 160),
    volume: text(input.volume, 100),
    variant: text(input.variant, 160),
    type: text(input.type, 120),
    abv: text(input.abv, 80),
    category: text(input.category, 140),
    description: text(input.description, 700),
    packaging: text(input.packaging, 140),
    country: text(input.country, 120),
    source: text(input.source, 180),
    matchConfidence: text(input.matchConfidence, 100),
    confidence: text(input.confidence || input.matchConfidence, 100),
    sourceEvidence: normalizeSourceEvidence(input.sourceEvidence, barcode),
    scope: text(input.scope || "in_scope", 60),
    photoVerified: input.photoVerified !== false,
    sourcePhotoCaptured: input.sourcePhotoCaptured === true,
    barcodePhotoConflict: input.barcodePhotoConflict === true,
    imageStatus: text(input.imageStatus, 60),
    assetVersion: text(input.assetVersion, 60),
    studioImageProcessing: text(input.studioImageProcessing, 120),
    studioImageVerified: input.studioImageVerified === true,
    studioImageWidth: Number(input.studioImageWidth) || 0,
    studioImageHeight: Number(input.studioImageHeight) || 0,
    needsReview: input.needsReview === true,
    reviewReason: text(input.reviewReason, 400),
    createdAt: text(input.createdAt, 80),
    updatedAt: text(input.updatedAt, 80),
  };

  if (!item.name) {
    const error = new Error("Product name is required before publishing.");
    error.status = 400;
    throw error;
  }
  return item;
}

function validatePublishableItem(item, hasExistingImage, hasNewImage) {
  const reasons = [];
  if (!item.barcode) reasons.push("a valid 8â€“14 digit barcode is required");
  if (item.canonicalProductId !== "gtin:" + item.barcode) reasons.push("canonical GTIN identity is missing");
  if (!item.name) reasons.push("product name is required");
  if (!item.brand) reasons.push("brand is required");
  if (!item.volume) reasons.push("bottle or pack size is required");
  if (!(item.type || item.category)) reasons.push("product type or category is required");
  if (!item.sourcePhotoCaptured) reasons.push("a source bottle photo is required");
  if (!item.photoVerified) reasons.push("bottle photo verification is required");
  if (item.barcodePhotoConflict) reasons.push("barcode and bottle photo conflict");
  if (item.needsReview) reasons.push(item.reviewReason || "item needs review");
  if (item.imageStatus !== "studio_verified") reasons.push("studio image verification is required");
  if (item.assetVersion !== STUDIO_ASSET_VERSION) reasons.push("unsupported studio asset version");
  if (!item.studioImageVerified) reasons.push("studio image has not been verified");
  if (item.studioImageWidth !== STUDIO_IMAGE_WIDTH || item.studioImageHeight !== STUDIO_IMAGE_HEIGHT) {
    reasons.push("studio image must be 1000 x 1000");
  }
  if (!/^ai-studio-generated-(?:gpt-image-1\.5|gpt-image-1|gpt-image-1-mini|chatgpt-image-latest)$/.test(item.studioImageProcessing)) {
    reasons.push("AI-generated studio image is required");
  }
  if (!hasExistingImage && !hasNewImage) reasons.push("verified studio image data is required");
  return Array.from(new Set(reasons));
}

function decodeImageDataUrl(value) {
  const candidate = text(value, MAX_IMAGE_DATA_LENGTH);
  const match = candidate.match(
    /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i,
  );
  if (!match) return null;

  const mime = match[1].toLowerCase() === "image/jpg"
    ? "image/jpeg"
    : match[1].toLowerCase();
  const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_DATA_LENGTH) {
    const error = new Error("The studio image is too large to publish.");
    error.status = 413;
    throw error;
  }

  return {
    base64: bytes.toString("base64"),
    extension: mime === "image/png" ? "png" : "jpg",
  };
}

function validImagePath(value) {
  const path = text(value, 240);
  return /^data\/inventory\/images\/[A-Za-z0-9._-]+\.(?:jpg|png)$/.test(path)
    ? path
    : "";
}

function rawImageUrl(repository, branch, path) {
  if (!path) return "";
  const parts = repository.split("/");
  return "https://raw.githubusercontent.com/" +
    parts.map((part) => encodeURIComponent(part)).join("/") +
    "/" + encodeURIComponent(branch) +
    "/" + path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function parseInventoryDocument(file) {
  if (!file?.content) {
    return { schemaVersion: INVENTORY_SCHEMA_VERSION, app: "backbar-product-identification", items: [], quarantinedItemCount: 0 };
  }
  try {
    const parsed = JSON.parse(file.content);
    return {
      schemaVersion: Number(parsed?.schemaVersion) || 1,
      app: text(parsed?.app || "backbar-product-identification", 120),
      quarantinedItemCount: Number(parsed?.quarantinedItemCount) || 0,
      items: Array.isArray(parsed?.items)
        ? parsed.items.filter((item) => item && typeof item === "object").slice(-MAX_ITEMS)
        : [],
    };
  } catch {
    return { schemaVersion: INVENTORY_SCHEMA_VERSION, app: "backbar-product-identification", items: [], quarantinedItemCount: 0 };
  }
}

function publicItem(item, imagePath, imageUrl, publishedAt) {
  return Object.assign({}, item, {
    github: {
      imagePath: imagePath || "",
      imageUrl: imageUrl || "",
      publishedAt,
    },
  });
}

export default async function publishInventory(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": ALLOWED_ORIGIN,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      },
    });
  }
  if (request.method !== "POST") {
    return response(405, { ok: false, error: "POST required" });
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== ALLOWED_ORIGIN) {
    return response(403, { ok: false, error: "Origin not allowed" });
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return response(415, { ok: false, error: "application/json required" });
  }

  let config;
  try {
    config = getConfig();
  } catch (error) {
    return response(error.status || 500, {
      ok: false,
      error: text(error.message || "GitHub publishing is unavailable.", 300),
    });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_CHARS) {
    return response(413, { ok: false, error: "Publish payload is too large." });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return response(400, { ok: false, error: "Valid JSON is required." });
  }

  try {
    const inputItem = payload?.item;
    const item = normalizeItem(inputItem);
    const now = new Date().toISOString();
    const inventoryFile = await readFile(config, INVENTORY_PATH);
    const document = parseInventoryDocument(inventoryFile);
    const previous = document.items.find((entry) =>
      entry.id === item.id ||
      (item.barcode && entry.barcode === item.barcode)
    );

    const image = decodeImageDataUrl(inputItem?.studioImageDataUrl);
    let imagePath = validImagePath(previous?.github?.imagePath);
    let imageUrl = rawImageUrl(config.repository, config.branch, imagePath);
    let imageCommit = null;
    const validationErrors = validatePublishableItem(item, !!imagePath, !!image);
    if (validationErrors.length) {
      const error = new Error("Inventory validation failed.");
      error.status = 422;
      error.validationErrors = validationErrors;
      throw error;
    }

    if (image) {
      imagePath = "data/inventory/images/" + item.id + "." + image.extension;
      imageUrl = rawImageUrl(config.repository, config.branch, imagePath);
      const existingImage = await readFile(config, imagePath);
      imageCommit = await writeBase64File(
        config,
        imagePath,
        image.base64,
        "Publish inventory image: " + item.name,
        existingImage?.sha,
      );
    }

    const published = publicItem(item, imagePath, imageUrl, now);
    const items = document.items.filter((entry) =>
      entry.id !== item.id &&
      !(item.barcode && entry.barcode && entry.barcode === item.barcode)
    );
    items.push(published);
    items.sort((left, right) =>
      String(left.name || "").localeCompare(String(right.name || ""))
    );

    const nextDocument = {
      schemaVersion: INVENTORY_SCHEMA_VERSION,
      app: "backbar-product-identification",
      repository: config.repository,
      branch: config.branch,
      updatedAt: now,
      quarantinedItemCount: document.quarantinedItemCount || 0,
      items: items.slice(-MAX_ITEMS),
    };
    const metadataCommit = await writeTextFile(
      config,
      INVENTORY_PATH,
      JSON.stringify(nextDocument, null, 2) + "\n",
      "Publish inventory item: " + item.name,
      inventoryFile?.sha,
    );

    return response(201, {
      ok: true,
      repository: config.repository,
      branch: config.branch,
      inventoryPath: INVENTORY_PATH,
      imagePath,
      imageUrl,
      publishedAt: now,
      commitSha: text(metadataCommit?.commit?.sha || imageCommit?.commit?.sha, 120),
      item: published,
    });
  } catch (error) {
    if (Array.isArray(error?.validationErrors)) {
      return response(422, {
        ok: false,
        error: "Inventory validation failed: " + error.validationErrors.join("; ") + ".",
        validationErrors: error.validationErrors,
      });
    }
    const githubStatus = Number(error?.status) || null;
    const status = githubStatus === 409
      ? 409
      : githubStatus === 401 || githubStatus === 403 || githubStatus === 404 || githubStatus === 422
        ? 502
        : githubStatus >= 400 && githubStatus < 500
          ? githubStatus
          : 500;
    return response(status, {
      ok: false,
      error: githubStatus
        ? "GitHub rejected the inventory publish."
        : text(error?.message || "Could not publish inventory.", 300),
      githubStatus,
    });
  }
}

export const config = {
  path: "/.netlify/functions/publish-inventory",
};
