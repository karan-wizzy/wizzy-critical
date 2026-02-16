const syncButton = document.getElementById("syncButton");
const statusEl = document.getElementById("status");
const logOutput = document.getElementById("logOutput");
const featureButtons = document.querySelectorAll("[data-feature-button]");
const featurePanels = document.querySelectorAll("[data-feature-panel]");

const DEFAULTS = {
  shopifyApiVersion: "2024-01",
  maxProducts: 500,
  shopifyMaxRetries: 5,
  shopifyInitialDelayMs: 500,
  wizzyMaxRetries: 3,
  wizzyInitialDelayMs: 500,
};

function setActiveFeature(featureName) {
  featureButtons.forEach((button) => {
    button.classList.toggle(
      "is-active",
      button.dataset.featureButton === featureName
    );
  });
  featurePanels.forEach((panel) => {
    panel.classList.toggle(
      "is-active",
      panel.dataset.featurePanel === featureName
    );
  });
}

featureButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setActiveFeature(button.dataset.featureButton);
  });
});

function getValue(id) {
  return document.getElementById(id).value.trim();
}

function getNumber(id) {
  const raw = document.getElementById(id).value.trim();
  if (!raw) return undefined;
  const num = Number(raw);
  return Number.isFinite(num) ? num : undefined;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function renderLogs(lines) {
  logOutput.textContent = lines.length ? lines.join("\n") : "No logs yet.";
}

function appendLog(lines, message) {
  lines.push(message);
  renderLogs(lines);
}

function sanitizeStoreDomain(value) {
  if (!value) return value;
  let domain = value.trim();
  domain = domain.replace(/^https?:\/\//i, "");
  domain = domain.replace(/\/+$/, "");
  return domain;
}

function normalizeConfig(raw) {
  const maxProducts = Number.isFinite(raw.maxProducts)
    ? Math.min(1000, Math.max(1, raw.maxProducts))
    : DEFAULTS.maxProducts;
  return {
    shopifyStoreDomain: sanitizeStoreDomain(raw.shopifyStoreDomain),
    shopifyAccessToken: raw.shopifyAccessToken,
    shopifyCollectionId: raw.shopifyCollectionId,
    shopifyApiVersion: raw.shopifyApiVersion || DEFAULTS.shopifyApiVersion,
    maxProducts,
    shopifyMaxRetries: Number.isFinite(raw.shopifyMaxRetries)
      ? raw.shopifyMaxRetries
      : DEFAULTS.shopifyMaxRetries,
    shopifyInitialDelayMs: Number.isFinite(raw.shopifyInitialDelayMs)
      ? raw.shopifyInitialDelayMs
      : DEFAULTS.shopifyInitialDelayMs,
    wizzySyncUrl: raw.wizzySyncUrl,
    wizzyStoreId: raw.wizzyStoreId,
    wizzyApiKey: raw.wizzyApiKey,
    wizzyPrivateKey: raw.wizzyPrivateKey,
    wizzyMaxRetries: Number.isFinite(raw.wizzyMaxRetries)
      ? raw.wizzyMaxRetries
      : DEFAULTS.wizzyMaxRetries,
    wizzyInitialDelayMs: Number.isFinite(raw.wizzyInitialDelayMs)
      ? raw.wizzyInitialDelayMs
      : DEFAULTS.wizzyInitialDelayMs,
  };
}

function validateConfig(config) {
  const missing = [];
  if (!config.shopifyStoreDomain) missing.push("shopifyStoreDomain");
  if (!config.shopifyAccessToken) missing.push("shopifyAccessToken");
  if (!config.shopifyCollectionId) missing.push("shopifyCollectionId");
  if (!config.wizzySyncUrl) missing.push("wizzySyncUrl");
  if (!config.wizzyStoreId) missing.push("wizzyStoreId");
  if (!config.wizzyApiKey) missing.push("wizzyApiKey");
  if (!config.wizzyPrivateKey) missing.push("wizzyPrivateKey");
  return missing;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, retryOptions) {
  const { maxRetries, initialDelayMs, shouldRetry, label, onLog } =
    retryOptions;
  let attempt = 0;
  let delay = initialDelayMs;

  while (true) {
    try {
      const response = await fetch(url, options);
      if (shouldRetry(response)) {
        attempt += 1;
        if (attempt > maxRetries) {
          return response;
        }
        if (onLog) {
          onLog(`${label} retry ${attempt}/${maxRetries} after ${response.status}`);
        }
        await sleep(delay);
        delay *= 2;
        continue;
      }

      return response;
    } catch (error) {
      attempt += 1;
      if (attempt > maxRetries) {
        throw error;
      }
      if (onLog) {
        onLog(`${label} retry ${attempt}/${maxRetries} after error`);
      }
      await sleep(delay);
      delay *= 2;
    }
  }
}

const QUERY = `
query getCollectionProducts($collectionId: ID!, $cursor: String, $first: Int!) {
  node(id: $collectionId) {
    ... on Collection {
      products(first: $first, after: $cursor) {
        edges {
          node {
            id
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`;

async function fetchCollectionProductGids(config, onLog) {
  let cursor = null;
  let hasNextPage = true;
  const gids = [];
  const maxProducts = Number.isFinite(config.maxProducts)
    ? Math.min(1000, Math.max(1, config.maxProducts))
    : null;

  while (hasNextPage) {
    const remaining = maxProducts ? maxProducts - gids.length : null;
    if (remaining !== null && remaining <= 0) {
      break;
    }
    const first = remaining !== null ? Math.min(250, remaining) : 250;
    const payload = JSON.stringify({
      query: QUERY,
      variables: {
        collectionId: config.shopifyCollectionGid,
        cursor,
        first,
      },
    });

    const response = await fetchWithRetry(
      config.shopifyUrl,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": config.shopifyAccessToken,
          "Content-Type": "application/json",
        },
        body: payload,
      },
      {
        maxRetries: config.shopifyMaxRetries,
        initialDelayMs: config.shopifyInitialDelayMs,
        shouldRetry: (res) => res.status === 429 || res.status >= 500,
        label: "Shopify",
        onLog,
      }
    );

    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Shopify request failed (${response.status}): ${text || "no body"}`
      );
    }

    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (error) {
      throw new Error(
        `Shopify response parse failed: ${text || "empty body"}`
      );
    }
    if (data.errors) {
      throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`);
    }

    const products = data?.data?.node?.products;
    const edges = Array.isArray(products?.edges) ? products.edges : [];
    for (const edge of edges) {
      if (edge?.node?.id) {
        gids.push(edge.node.id);
        if (maxProducts && gids.length >= maxProducts) {
          break;
        }
      }
    }

    hasNextPage = Boolean(products?.pageInfo?.hasNextPage);
    cursor = products?.pageInfo?.endCursor || null;
    if (maxProducts && gids.length >= maxProducts) {
      hasNextPage = false;
    }
    if (onLog) {
      const limitNote = maxProducts ? `/${maxProducts}` : "";
      onLog(
        `Fetched ${gids.length}${limitNote} product IDs so far (hasNextPage=${hasNextPage})`
      );
    }

    if (hasNextPage && !cursor) {
      throw new Error("Pagination cursor missing while hasNextPage=true");
    }
  }

  return gids;
}

function gidToNumericId(gid) {
  const prefix = "gid://shopify/Product/";
  let raw = String(gid).trim();
  if (raw.startsWith(prefix)) {
    raw = raw.slice(prefix.length).trim();
  }
  const num = Number(raw);
  if (!Number.isSafeInteger(num)) {
    throw new Error(`Product ID is not a safe integer: ${raw}`);
  }
  return num;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function syncWizzyBatch(config, products, index, total, onLog) {
  const headers = {
    "Content-Type": "application/json",
    "x-store-id": config.wizzyStoreId,
    "x-api-key": config.wizzyApiKey,
    "x-private-key": config.wizzyPrivateKey,
  };

  const response = await fetchWithRetry(
    config.wizzySyncUrl,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ products }),
    },
    {
      maxRetries: config.wizzyMaxRetries,
      initialDelayMs: config.wizzyInitialDelayMs,
      shouldRetry: (res) => res.status >= 500,
      label: `Wizzy batch ${index + 1}/${total}`,
      onLog,
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Wizzy batch ${index + 1}/${total} failed (${response.status}): ${
        text || "no body"
      }`
    );
  }
}

async function runSync(config, onLog) {
  const shopifyApiVersion = config.shopifyApiVersion || DEFAULTS.shopifyApiVersion;
  const collectionId = String(config.shopifyCollectionId).trim();
  const collectionGid = collectionId.startsWith("gid://")
    ? collectionId
    : `gid://shopify/Collection/${collectionId}`;
  const shopifyUrl = `https://${config.shopifyStoreDomain}/admin/api/${shopifyApiVersion}/graphql.json`;

  const effectiveConfig = {
    ...config,
    shopifyApiVersion,
    shopifyUrl,
    shopifyCollectionGid: collectionGid,
  };

  if (onLog) onLog("Fetching Shopify collection product IDs...");
  const gids = await fetchCollectionProductGids(effectiveConfig, onLog);
  if (onLog) onLog(`Total product GIDs fetched: ${gids.length}`);

  const numericIds = gids.map(gidToNumericId);
  const batches = chunkArray(numericIds, 250);

  if (onLog) {
    onLog(`Syncing ${numericIds.length} IDs in ${batches.length} batches`);
  }

  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    try {
      await syncWizzyBatch(effectiveConfig, batch, i, batches.length, onLog);
      successCount += 1;
      if (onLog) onLog(`Wizzy batch ${i + 1}/${batches.length} synced`);
    } catch (error) {
      failureCount += 1;
      if (onLog) onLog(error.message);
    }
  }

  return {
    totalProducts: numericIds.length,
    totalBatches: batches.length,
    successBatches: successCount,
    failedBatches: failureCount,
  };
}

syncButton.addEventListener("click", async () => {
  const rawConfig = {
    shopifyStoreDomain: getValue("shopifyStoreDomain"),
    shopifyAccessToken: getValue("shopifyAccessToken"),
    shopifyCollectionId: getValue("shopifyCollectionId"),
    shopifyApiVersion: getValue("shopifyApiVersion"),
    maxProducts: getNumber("maxProducts"),
    wizzySyncUrl: getValue("wizzySyncUrl"),
    wizzyStoreId: getValue("wizzyStoreId"),
    wizzyApiKey: getValue("wizzyApiKey"),
    wizzyPrivateKey: getValue("wizzyPrivateKey"),
    shopifyMaxRetries: getNumber("shopifyMaxRetries"),
    shopifyInitialDelayMs: getNumber("shopifyInitialDelayMs"),
    wizzyMaxRetries: getNumber("wizzyMaxRetries"),
    wizzyInitialDelayMs: getNumber("wizzyInitialDelayMs"),
  };

  const config = normalizeConfig(rawConfig);
  const missing = validateConfig(config);
  if (missing.length) {
    setStatus("Missing required fields");
    renderLogs([`Missing required fields: ${missing.join(", ")}`]);
    return;
  }

  syncButton.disabled = true;
  setStatus("Running...");
  const logs = ["Starting sync..."];
  renderLogs(logs);

  try {
    const summary = await runSync(config, (message) => appendLog(logs, message));
    setStatus(
      `Done. Products: ${summary.totalProducts || 0}, Batches: ${
        summary.totalBatches || 0
      }, Failed: ${summary.failedBatches || 0}`
    );
  } catch (error) {
    setStatus(error.message || "Sync failed");
    appendLog(logs, error.message || "Sync failed");
  } finally {
    syncButton.disabled = false;
  }
});

setActiveFeature("shopify-sync");
