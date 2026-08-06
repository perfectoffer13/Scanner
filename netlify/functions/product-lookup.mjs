const ALLOWED_ORIGIN = "https://backbar-product-scanner.netlify.app";
const USER_AGENT = "BackbarProductScanner/0.2 (+https://backbar-product-scanner.netlify.app)";
const REQUEST_TIMEOUT_MS = 8000;
const MAX_TEXT = 6000;

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
  return haystack ? "Beverage" : "";
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
  };
  merged.description = merged.description || productDescription(merged, merged);
  return merged;
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

async function fetchJson(url, source) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
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

  if (!product) {
    return jsonResponse(200, {
      ok: true,
      found: false,
      barcode,
      sources: attempts,
    });
  }

  return jsonResponse(200, {
    ok: true,
    found: true,
    barcode,
    product,
    sources: attempts,
  });
}

export const config = {
  path: "/.netlify/functions/product-lookup",
};
