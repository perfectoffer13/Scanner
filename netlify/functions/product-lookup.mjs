const ALLOWED_ORIGIN = "https://backbar-product-scanner.netlify.app";
const USER_AGENT = "BackbarProductScanner/0.6 (+https://backbar-product-scanner.netlify.app)";
const REQUEST_TIMEOUT_MS = 8000;
const MAX_TEXT = 6000;
const AI_LOOKUP_TIMEOUT_MS = 25000;
const AI_LOOKUP_MODEL = "claude-haiku-4-5-20251001";
const AI_WEB_SEARCH_MAX_USES = 2;
const AI_LOOKUP_MAX_PAUSE_CONTINUATIONS = 2;
const LIQUID_STOCK_KEYWORDS = [
  "beverage", "drink", "soft drink", "cooldrink", "cola", "soda",
  "juice", "water", "tonic", "mixer", "energy drink", "beer", "lager",
  "ale", "cider", "wine", "champagne", "prosecco", "brandy", "cognac",
  "whisky", "whiskey", "bourbon", "scotch", "vodka", "gin", "rum",
  "tequila", "mezcal", "liqueur", "liquor", "schnapps", "amaro",
  "aperitif", "digestif", "spirit", "shot", "cordial", "syrup",
  "milk", "coffee", "tea", "kombucha", "smoothie", "dairy drink"
];
const NON_LIQUID_KEYWORDS = [
  "butter", "margarine", "spread", "bread", "biscuit", "cookie",
  "chocolate", "candy", "snack", "cereal", "flour", "rice", "pasta",
  "soap", "shampoo", "cosmetic", "lotion", "cream", "toothpaste",
  "battery", "sponge", "diaper", "detergent", "cleaner", "washing powder"
];

function text(value, maxLength = MAX_TEXT) {
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

function listText(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return text(item);
        if (item && typeof item === "object") {
          return firstText(item.text, item.name, item.id);
        }
        return "";
      })
      .filter(Boolean)
      .join(", ");
  }
  return text(value);
}

function imageUrl(value) {
  const candidate = text(value, 1000);
  return /^https?:\/\//i.test(candidate) ? candidate : "";
}

function findImage(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const found = findImage(...value);
      if (found) return found;
    } else if (value && typeof value === "object") {
      const found = findImage(
        value.front,
        value.display,
        value.full,
        value.small,
        value.thumb,
        value.en,
        value.xx,
      );
      if (found) return found;
    } else {
      const found = imageUrl(value);
      if (found) return found;
    }
  }
  return "";
}

function parseNumber(value) {
  const match = String(value ?? "").replace(",", ".").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function normalizeAbv(...values) {
  for (const value of values) {
    const number = parseNumber(value);
    if (!Number.isFinite(number)) continue;
    const percentage = number > 0 && number <= 1 ? number * 100 : number;
    if (percentage > 0 && percentage <= 100) {
      return String(Number(percentage.toFixed(2))) + "% ABV";
    }
  }
  return "";
}

function extractVolume(...values) {
  for (const value of values) {
    const candidate = text(value);
    if (!candidate) continue;
    const match = candidate.match(/\b(?:\d+(?:[.,]\d+)?\s*(?:ml|cl|l|litre|litres|liter|liters|oz|fl\.?\s*oz))\b/i);
    if (match) return match[0].replace(/\s+/g, " ").trim();
  }
  return "";
}

function inferType(...values) {
  const haystack = values.map((value) => text(value).toLowerCase()).join(" ");
  const types = [
    ["Energy drink", ["energy drink", "energy-drink"]],
    ["Soft drink / Cooldrink", ["soft drink", "carbonated drink", "soda", "cola", "lemonade", "cooldrink"]],
    ["Juice", ["juice", "fruit drink", "nectar"]],
    ["Mixer / Tonic", ["tonic", "mixer", "soda water", "ginger ale"]],
    ["Brandy", ["brandy", "cognac", "armagnac"]],
    ["Whisky / Whiskey", ["whisky", "whiskey", "bourbon", "scotch"]],
    ["Vodka", ["vodka"]],
    ["Gin", ["gin"]],
    ["Rum", ["rum", "cachaça", "cachaca"]],
    ["Tequila", ["tequila", "mezcal"]],
    ["Liqueur", ["liqueur", "liquor", "schnapps", "amaro", "aperitif", "digestif"]],
    ["Wine", ["wine", "vino", "champagne", "prosecco", "cava", "sangria"]],
    ["Beer", ["beer", "lager", "ale", "stout", "pilsner"]],
    ["Cider", ["cider", "perry"]],
    ["Shot", ["shot"]],
  ];

  for (const [label, words] of types) {
    if (words.some((word) => haystack.includes(word))) return label;
  }
  return "";
}

function inferVariant(product, name) {
  return firstText(
    product.flavor,
    product.flavours,
    product.variant,
    product.variety,
    product.designation,
    product.generic_name_en,
    product.generic_name,
  ).replace(name, "").replace(/^[-–—,:\s]+|[-–—,:\s]+$/g, "");
}

function productDescription(product, fields) {
  const parts = [
    fields.brand,
    fields.name,
    fields.variant,
    fields.volume,
    fields.abv,
  ].filter(Boolean);
  return parts.join(", ");
}

function normalizeOpenFoodFacts(data, barcode) {
  const product = data?.product;
  if (!product) return null;

  const name = firstText(
    product.product_name_en,
    product.product_name,
    product.abbreviated_product_name_en,
    product.abbreviated_product_name,
    product.generic_name_en,
    product.generic_name,
  );
  const brand = firstText(product.brands, listText(product.brands_tags));
  const categories = firstText(product.categories, listText(product.categories_tags));
  const volume = firstText(
    product.quantity,
    product.product_quantity,
    extractVolume(product.product_name, product.generic_name),
  );
  const fields = {
    name,
    brand,
    variant: inferVariant(product, name),
    volume,
    abv: normalizeAbv(
      product.alcohol,
      product.alcohol_100g,
      product.alcohol_value,
      product.alcohol_percent,
    ),
  };

  return {
    barcode,
    name: fields.name,
    brand: fields.brand,
    type: inferType(categories, fields.name, product.generic_name, product.labels),
    variant: fields.variant,
    volume: fields.volume,
    abv: fields.abv,
    packaging: firstText(product.packaging_text, product.packaging),
    country: firstText(product.countries, product.origins),
    category: categories,
    description: productDescription(product, fields),
    source: "Open Food Facts",
    sourceRecordUrl: firstText(
      product.url,
      "https://world.openfoodfacts.org/product/" + encodeURIComponent(barcode),
    ),
    sourceImageUrl: findImage(
      product.image_front_url,
      product.image_front_small_url,
      product.image_url,
      product.image_thumb_url,
      product.selected_images,
    ),
  };
}

function normalizeUPCItem(data, barcode) {
  const item = Array.isArray(data?.items) ? data.items[0] : null;
  if (!item) return null;

  const name = firstText(item.title, item.name);
  const volume = extractVolume(name, item.description, item.size, item.dimension);
  const fields = {
    name,
    brand: firstText(item.brand, item.manufacturer),
    variant: "",
    volume,
    abv: normalizeAbv(name, item.description),
  };

  return {
    barcode,
    name: fields.name,
    brand: fields.brand,
    type: inferType(item.category, name, item.description),
    variant: fields.variant,
    volume: fields.volume,
    abv: fields.abv,
    packaging: "",
    country: "",
    category: text(item.category),
    description: firstText(item.description, productDescription(item, fields)),
    source: "UPCitemdb",
    sourceRecordUrl: "https://www.upcitemdb.com/upc/" + encodeURIComponent(barcode),
    sourceImageUrl: findImage(item.images),
  };
}


function normalizeBarcodeCatalogProduct(data, barcode, source, fallbackUrl) {
  const root = data && typeof data === "object" ? data : null;
  const payload = root && root.data && typeof root.data === "object"
    ? root.data
    : root;
  const item = payload && payload.product && typeof payload.product === "object"
    ? payload.product
    : payload && payload.item && typeof payload.item === "object"
      ? payload.item
      : payload;

  if (!item || typeof item !== "object") return null;

  const name = firstText(
    item.name,
    item.product_name,
    item.productName,
    item.title,
    item.display_name,
    item.displayName,
  );
  const brand = firstText(
    item.brand,
    item.brand_name,
    item.brandName,
    item.manufacturer,
    item.manufacturer_name,
  );
  const category = firstText(
    item.category,
    item.category_name,
    item.categoryName,
    item.product_type,
    item.productType,
    item.department,
  );
  const description = firstText(
    item.description,
    item.product_description,
    item.productDescription,
    item.about,
  );
  const volume = firstText(
    item.volume,
    item.size,
    item.quantity,
    item.net_content,
    item.netContent,
    extractVolume(name, description),
  );
  const variant = firstText(
    item.variant,
    item.flavor,
    item.flavour,
    item.flavor_name,
    item.flavour_name,
  );
  const type = firstText(
    item.type,
    item.product_type,
    item.productType,
    inferType(category, name, description),
  );
  const abv = normalizeAbv(
    item.abv,
    item.alcohol,
    item.alcohol_content,
    item.alcohol_percentage,
    name,
    description,
  );

  if (!name && !brand) return null;

  const fields = { name, brand, variant, volume, abv };

  return {
    barcode,
    name,
    brand,
    type,
    variant,
    volume,
    abv,
    packaging: firstText(item.packaging, item.package_type, item.packageType),
    country: firstText(item.country, item.origin, item.country_of_origin),
    category,
    description: firstText(description, productDescription(item, fields)),
    source,
    sourceRecordUrl: firstText(
      item.url,
      item.product_url,
      item.productUrl,
      item.link,
      fallbackUrl,
    ),
    sourceImageUrl: findImage(
      item.image_url,
      item.imageUrl,
      item.image,
      item.images,
      item.thumbnail,
      item.thumbnail_url,
      item.photo,
      item.photos,
    ),
    matchConfidence: firstText(
      item.confidence,
      item.confidence_score,
      item.data_quality_score,
    ),
    evidence: firstText(
      item.source_count ? String(item.source_count) + " catalog sources" : "",
      item.evidence,
    ),
    scope: "",
  };
}

function mergeProducts(primary, secondary, barcode) {
  if (!primary) return secondary;
  if (!secondary) return primary;

  const merged = {
    barcode,
    name: firstText(primary.name, secondary.name),
    brand: firstText(primary.brand, secondary.brand),
    type: firstText(primary.type, secondary.type),
    variant: firstText(primary.variant, secondary.variant),
    volume: firstText(primary.volume, secondary.volume),
    abv: firstText(primary.abv, secondary.abv),
    packaging: firstText(primary.packaging, secondary.packaging),
    country: firstText(primary.country, secondary.country),
    category: firstText(primary.category, secondary.category),
    description: firstText(primary.description, secondary.description),
    source: primary.source + " + " + secondary.source,
    sourceRecordUrl: firstText(primary.sourceRecordUrl, secondary.sourceRecordUrl),
    sourceImageUrl: firstText(primary.sourceImageUrl, secondary.sourceImageUrl),
    sourceUrls: Array.from(new Set([...(primary.sourceUrls || []), ...(secondary.sourceUrls || [])])),
    matchConfidence: firstText(primary.matchConfidence, secondary.matchConfidence),
    evidence: firstText(primary.evidence, secondary.evidence),
    scope: firstText(primary.scope, secondary.scope),
  };
  merged.description = merged.description || productDescription(merged, merged);
  return merged;
}


function hasUsableProduct(product) {
  return Boolean(
    product &&
    product.name &&
    (product.brand || product.category || product.type),
  );
}

function productSearchText(product) {
  return [
    product && product.name,
    product && product.brand,
    product && product.type,
    product && product.variant,
    product && product.volume,
    product && product.abv,
    product && product.category,
    product && product.description
  ].map(value => text(value)).filter(Boolean).join(" ").toLowerCase();
}

function containsKeyword(value, keywords) {
  const haystack = text(value).toLowerCase();
  return keywords.some(keyword => haystack.includes(keyword));
}

function isLiquidStockProduct(product) {
  if (!product) return false;
  const haystack = productSearchText(product);
  if (!haystack || containsKeyword(haystack, NON_LIQUID_KEYWORDS)) return false;
  return containsKeyword(haystack, LIQUID_STOCK_KEYWORDS);
}

function outOfScopeProductSummary(product) {
  if (!product) return null;
  return {
    name:firstText(product.name),
    brand:firstText(product.brand),
    volume:firstText(product.volume),
    type:firstText(product.type),
    category:firstText(product.category),
    description:firstText(product.description),
    source:firstText(product.source),
    matchConfidence:firstText(product.matchConfidence)
  };
}

function responseOutputText(data) {
  if (data && typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  const chunks = [];
  const content = Array.isArray(data && data.content) ? data.content : [];
  for (const piece of content) {
    if (typeof (piece && piece.text) === "string") chunks.push(piece.text);
    else if (typeof (piece && piece.text && piece.text.value) === "string") chunks.push(piece.text.value);
  }

  const output = Array.isArray(data && data.output) ? data.output : [];
  for (const item of output) {
    const itemContent = Array.isArray(item && item.content) ? item.content : [];
    for (const piece of itemContent) {
      if (typeof (piece && piece.text) === "string") chunks.push(piece.text);
      else if (typeof (piece && piece.text && piece.text.value) === "string") chunks.push(piece.text.value);
    }
  }

  return chunks.join("\n");
}

function responseCitationUrls(data) {
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

    Object.values(value).forEach((child) => {
      if (child && typeof child === "object") visit(child);
    });
  }

  visit(data);
  return urls.slice(0, 8);
}

function parseAIJson(value) {
  const raw = text(value, 12000)
    .replace(/^[\u0060]{3}(?:json)?\s*/i, "")
    .replace(/\s*[\u0060]{3}$/i, "")
    .trim();

  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function normalizeAIProduct(data, barcode, citationUrls) {
  if (!data || data.found !== true) return null;

  const name = firstText(data.name, data.product_name, data.title);
  const confidence = ["high", "medium", "low"].includes(String(data.confidence).toLowerCase())
    ? String(data.confidence).toLowerCase()
    : "low";
  if (!name) return null;

  const sourceUrls = [];
  const seen = new Set();
  for (const value of [
    ...(Array.isArray(data.source_urls) ? data.source_urls : []),
    ...(Array.isArray(data.sourceUrls) ? data.sourceUrls : []),
    ...citationUrls,
  ]) {
    const url = imageUrl(value);
    if (url && !seen.has(url)) {
      seen.add(url);
      sourceUrls.push(url);
    }
  }

  const fields = {
    name,
    brand: firstText(data.brand),
    variant: firstText(data.variant, data.flavour, data.flavor),
    volume: firstText(data.volume, data.size, extractVolume(name, data.description)),
    abv: firstText(data.abv, data.alcohol_strength, data.alcohol),
  };

  return {
    barcode,
    name: fields.name,
    brand: fields.brand,
    type: firstText(data.type, data.product_type, data.category),
    variant: fields.variant,
    volume: fields.volume,
    abv: fields.abv,
    packaging: firstText(data.packaging),
    country: firstText(data.country, data.origin),
    category: firstText(data.category, data.product_type),
    description: firstText(data.description, productDescription(data, fields)),
    source: "AI web evidence",
    sourceRecordUrl: firstText(sourceUrls[0]),
    sourceImageUrl: imageUrl(data.image_url || data.imageUrl),
    sourceUrls,
    matchConfidence: confidence,
    evidence: firstText(data.evidence),
    scope: firstText(data.scope, "unknown"),
  };
}

async function lookupWithAI(barcode) {
  const enabled = String(process.env.AI_BARCODE_LOOKUP_ENABLED || "").toLowerCase() === "true";
  if (!enabled) {
    return {
      configured: false,
      status: 0,
      ok: false,
      product: null,
      confidence: null,
      error: "not_configured",
      elapsedMs: 0,
    };
  }

  const apiKey = text(process.env.ANTHROPIC_API_KEY, 300);
  if (!apiKey) {
    return {
      configured: false,
      status: 0,
      ok: false,
      product: null,
      confidence: null,
      error: "missing_api_key",
      elapsedMs: 0,
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_LOOKUP_TIMEOUT_MS);
  const startedAt = Date.now();
  const model = process.env.ANTHROPIC_BARCODE_MODEL || AI_LOOKUP_MODEL;
  const searchForms = barcodeSearchForms(barcode);
  const input = [
    "You are the exact-barcode evidence resolver for a hospitality liquid-stock inventory app.",
    "Always use web search for this request; do not answer from memory.",
    "Identify the retail item associated with the exact barcode for bars, pubs, restaurants, bottle shops, and hospitality venues.",
    "Prioritize spirits, wine, beer, cider, cooldrinks or soft drinks, water, juices, mixers, energy drinks, syrups, and shots.",
    "Search the exact unbroken barcode first, then its valid equivalent UPC-A or GTIN-13 representation if applicable.",
    "Use the two searches efficiently: search the exact digits with beverage/product terms and search the exact digits with local retailer, distributor, manufacturer, or catalog terms.",
    "A retailer page, distributor listing, official promotion PDF, inventory catalog, or manufacturer page is acceptable evidence when the exact barcode and the item appear together.",
    "Do not identify an item from a similar barcode, a product name alone, or general category knowledge.",
    "For beverages, return the brand, full product name, variant or flavour, container size, ABV when applicable, beverage type, packaging, country of origin, and a concise inventory description.",
    "If the exact barcode belongs to a solid food or non-liquid item, return found:false and scope:out_of_scope.",
    "Do not guess missing fields. Use an empty string for unsupported fields.",
    "Return only one JSON object, with no Markdown, using this shape:",
    '{"found":true,"scope":"in_scope|out_of_scope|unknown","name":"","brand":"","type":"","variant":"","volume":"","abv":"","packaging":"","country":"","category":"","description":"","image_url":"","source_urls":[],"confidence":"high|medium|low|none","evidence":""}',
    "Set found:true only when a cited source explicitly connects this exact barcode or an equivalent UPC/GTIN form to the product.",
    "If no reliable exact-code match is found, return found:false, scope:unknown, empty product fields, confidence:none, and explain why in evidence.",
    "Barcode forms to search: " + searchForms.map((value) => '"' + value + '"').join(" OR "),
  ].join("\n");

  function aiSearchLocation(){
    const country = text(
      process.env.ANTHROPIC_BARCODE_COUNTRY || "ZA",
      2
    ).toUpperCase();
    const timezone = text(
      process.env.ANTHROPIC_BARCODE_TIMEZONE || "Africa/Johannesburg",
      80
    );
    return {
      type:"approximate",
      country:/^[A-Z]{2}$/.test(country) ? country : "ZA",
      timezone:timezone || "Africa/Johannesburg"
    };
  }

  const requestBody = (messages) => ({
    model,
    max_tokens: 800,
    tools: [{
      type: "web_search_20250305",
      name: "web_search",
      max_uses: AI_WEB_SEARCH_MAX_USES,
      user_location: aiSearchLocation(),
    }],
    messages,
  });

  async function requestAnthropic(messages) {
    return fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(requestBody(messages)),
    });
  }

  try {
    const responseData = [];
    const messages = [
      { role: "user", content: input },
    ];
    let response = await requestAnthropic(messages);
    let raw = await response.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    responseData.push(data);

    let pauseContinuations = 0;
    while (
      response.ok &&
      data &&
      data.stop_reason === "pause_turn" &&
      Array.isArray(data.content) &&
      pauseContinuations < AI_LOOKUP_MAX_PAUSE_CONTINUATIONS
    ) {
      // Anthropic requires the paused assistant content to be sent back
      // unchanged, with the same server-side web-search tool definition.
      messages.push({ role: "assistant", content: data.content });
      pauseContinuations++;
      response = await requestAnthropic(messages);
      raw = await response.text();
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        data = null;
      }
      responseData.push(data);
    }

    const responseText = responseOutputText(data);
    const parsed = parseAIJson(responseText);
    const citationUrls = responseCitationUrls(responseData);
    const product = response.ok
      ? normalizeAIProduct(parsed, barcode, citationUrls)
      : null;

    return {
      configured: true,
      status: response.status,
      ok: response.ok,
      model,
      webSearchMaxUses: AI_WEB_SEARCH_MAX_USES,
      pauseContinuations,
      stopReason: data && data.stop_reason ? data.stop_reason : null,
      product,
      confidence: product && product.matchConfidence ? product.matchConfidence : null,
      error: response.ok
        ? (parsed ? null : "invalid_ai_json")
        : text(data && data.error && data.error.message || raw, 320),
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      configured: true,
      status: 0,
      ok: false,
      product: null,
      confidence: null,
      error: text(error && (error.message || error), 320),
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": ALLOWED_ORIGIN,
      vary: "Origin",
    },
  });
}

function normalizedBarcode(value) {
  const candidate = text(value, 80);
  return /^[A-Za-z0-9._-]{3,80}$/.test(candidate) ? candidate : "";
}

function barcodeSearchForms(barcode) {
  const forms = [barcode];
  if (/^\d{12}$/.test(barcode)) forms.push("0" + barcode);
  if (/^0\d{12}$/.test(barcode)) forms.push(barcode.slice(1));
  return Array.from(new Set(forms));
}

async function fetchJson(url, source) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  const headers = {
    accept: "application/json",
    "user-agent": USER_AGENT,
  };

  if (source === "upc.dev" && text(process.env.UPC_DEV_API_KEY, 300)) {
    headers["x-api-key"] = text(process.env.UPC_DEV_API_KEY, 300);
  }
  if (source === "GTINHub" && text(process.env.GTINHUB_API_KEY, 300)) {
    headers["x-api-key"] = text(process.env.GTINHUB_API_KEY, 300);
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers,
    });
    const raw = await response.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }

    return {
      source,
      status: response.status,
      ok: response.ok,
      data,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      source,
      status: 0,
      ok: false,
      data: null,
      elapsedMs: Date.now() - startedAt,
      error: text(error?.message || error, 300),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export default async function productLookup(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": ALLOWED_ORIGIN,
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type",
      },
    });
  }

  if (request.method !== "GET") {
    return jsonResponse(405, { ok: false, error: "GET required" });
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== ALLOWED_ORIGIN) {
    return jsonResponse(403, { ok: false, error: "Origin not allowed" });
  }

  const url = new URL(request.url);
  const barcode = normalizedBarcode(url.searchParams.get("barcode"));
  if (!barcode) {
    return jsonResponse(400, {
      ok: false,
      error: "A valid barcode is required",
    });
  }

  const fields = [
    "code",
    "product_name",
    "product_name_en",
    "abbreviated_product_name",
    "abbreviated_product_name_en",
    "generic_name",
    "generic_name_en",
    "brands",
    "brands_tags",
    "quantity",
    "product_quantity",
    "categories",
    "categories_tags",
    "labels",
    "countries",
    "origins",
    "packaging",
    "packaging_text",
    "flavor",
    "flavours",
    "variant",
    "variety",
    "designation",
    "alcohol",
    "alcohol_100g",
    "alcohol_value",
    "alcohol_percent",
    "image_front_url",
    "image_front_small_url",
    "image_url",
    "image_thumb_url",
    "selected_images",
    "url",
  ].join(",");

  const openFoodFactsUrl =
    "https://world.openfoodfacts.org/api/v3/product/" +
    encodeURIComponent(barcode) +
    "?product_type=all&fields=" +
    encodeURIComponent(fields);

  const attempts = [];
  const openFoodFactsResult = await fetchJson(
    openFoodFactsUrl,
    "Open Food Facts v3",
  );
  attempts.push({
    source: openFoodFactsResult.source,
    status: openFoodFactsResult.status,
    ok: openFoodFactsResult.ok,
    elapsedMs: openFoodFactsResult.elapsedMs,
    error: openFoodFactsResult.error || null,
  });

  let product = normalizeOpenFoodFacts(
    openFoodFactsResult.data,
    barcode,
  );

  if (!product || !product.name || !product.brand || !product.volume) {
    const upcUrl =
      "https://api.upcitemdb.com/prod/trial/lookup?upc=" +
      encodeURIComponent(barcode);
    const upcResult = await fetchJson(upcUrl, "UPCitemdb trial");
    attempts.push({
      source: upcResult.source,
      status: upcResult.status,
      ok: upcResult.ok,
      elapsedMs: upcResult.elapsedMs,
      error: upcResult.error || null,
    });
    product = mergeProducts(
      product,
      normalizeUPCItem(upcResult.data, barcode),
      barcode,
    );
  }

  if (!product || !product.name || !product.brand || !product.volume) {
    const upcDevUrl =
      "https://upc.dev/v1/product/" + encodeURIComponent(barcode);
    const upcDevResult = await fetchJson(upcDevUrl, "upc.dev");
    attempts.push({
      source: upcDevResult.source,
      status: upcDevResult.status,
      ok: upcDevResult.ok,
      found: !!normalizeBarcodeCatalogProduct(
        upcDevResult.data,
        barcode,
        "upc.dev",
        "https://upc.dev/product/" + encodeURIComponent(barcode),
      ),
      elapsedMs: upcDevResult.elapsedMs,
      error: upcDevResult.error || null,
    });
    product = mergeProducts(
      product,
      normalizeBarcodeCatalogProduct(
        upcDevResult.data,
        barcode,
        "upc.dev",
        "https://upc.dev/product/" + encodeURIComponent(barcode),
      ),
      barcode,
    );
  }

  const gtinHubEnabled =
    String(process.env.GTINHUB_LOOKUP_ENABLED || "true").toLowerCase() !== "false";
  if (gtinHubEnabled && (!product || !product.name || !product.brand || !product.volume)) {
    const gtinHubUrl =
      "https://gtinhub.com/api/v1/product/" + encodeURIComponent(barcode);
    const gtinHubResult = await fetchJson(gtinHubUrl, "GTINHub");
    attempts.push({
      source: gtinHubResult.source,
      status: gtinHubResult.status,
      ok: gtinHubResult.ok,
      found: !!normalizeBarcodeCatalogProduct(
        gtinHubResult.data,
        barcode,
        "GTINHub",
        "https://gtinhub.com/api/v1/product/" + encodeURIComponent(barcode),
      ),
      elapsedMs: gtinHubResult.elapsedMs,
      error: gtinHubResult.error || null,
    });
    product = mergeProducts(
      product,
      normalizeBarcodeCatalogProduct(
        gtinHubResult.data,
        barcode,
        "GTINHub",
        "https://gtinhub.com/api/v1/product/" + encodeURIComponent(barcode),
      ),
      barcode,
    );
  }

  if (!hasUsableProduct(product) || !product.volume || !product.brand) {
    const aiResult = await lookupWithAI(barcode);
    attempts.push({
      source: "AI web evidence",
      status: aiResult.status,
      ok: aiResult.ok,
      configured: aiResult.configured,
      found: !!aiResult.product,
      confidence: aiResult.confidence || null,
      model: aiResult.model || null,
      webSearchMaxUses: aiResult.webSearchMaxUses || AI_WEB_SEARCH_MAX_USES,
      pauseContinuations: aiResult.pauseContinuations || 0,
      stopReason: aiResult.stopReason || null,
      elapsedMs: aiResult.elapsedMs,
      error: aiResult.error || null,
    });
    product = mergeProducts(product, aiResult.product, barcode);
  }

  if (!hasUsableProduct(product)) {
    return jsonResponse(200, {
      ok: true,
      found: false,
      scope: "liquid_stock",
      outOfScopeProduct: null,
      barcode,
      sources: attempts,
      aiLookup: {
        enabled: String(process.env.AI_BARCODE_LOOKUP_ENABLED || "").toLowerCase() === "true",
        configured: !!process.env.ANTHROPIC_API_KEY,
      },
    });
  }

  if (!isLiquidStockProduct(product)) {
    attempts.push({
      source: "Liquid-stock scope",
      status: 200,
      ok: true,
      inScope: false,
      reason: "verified_non_liquid_or_out_of_scope",
    });
    return jsonResponse(200, {
      ok: true,
      found: false,
      scope: "liquid_stock",
      outOfScopeProduct: outOfScopeProductSummary(product),
      barcode,
      sources: attempts,
      aiLookup: {
        enabled: String(process.env.AI_BARCODE_LOOKUP_ENABLED || "").toLowerCase() === "true",
        configured: !!process.env.ANTHROPIC_API_KEY,
      },
    });
  }

  return jsonResponse(200, {
    ok: true,
    found: true,
    scope: "liquid_stock",
    barcode,
    product,
    sources: attempts,
  });
}

export const config = {
  path: "/.netlify/functions/product-lookup",
};
