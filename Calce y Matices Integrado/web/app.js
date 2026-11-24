let resolveAuthStateReady;
window.calceAuthStateReady = new Promise(resolve => {
  resolveAuthStateReady = resolve;
});

const protectedPagePanelIds = {
  home: "home-panel",
  "try-on": "try-on-panel",
  profile: "profile-panel",
};

const setProtectedPageVisibility = isAuthenticated => {
  const view = new URLSearchParams(window.location.search).get("view");
  const panelId = protectedPagePanelIds[view];
  if (!panelId) return;
  const panel = document.getElementById(panelId);
  if (panel) panel.hidden = !isAuthenticated;
  if (isAuthenticated) {
    window.dispatchEvent(new CustomEvent("calce:protected-page-visible", {
      detail: { view },
    }));
  }
};

const finishAuthStateInitialization = isAuthenticated => {
  setProtectedPageVisibility(isAuthenticated);
  if (!resolveAuthStateReady) return;
  resolveAuthStateReady(isAuthenticated);
  resolveAuthStateReady = null;
};

const readJsonResponse = async (response, endpoint) => {
  const body = await response.text();
  const contentType = response.headers.get("content-type") || "sin Content-Type";
  if (!body.trim()) {
    throw new Error(
      `${endpoint}: respuesta vacía (HTTP ${response.status}, ${contentType}).`,
    );
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `${endpoint}: respuesta no JSON (HTTP ${response.status}, ${contentType}).`,
      );
    }
    throw error;
  }
};

const catalogSelectionStorageKey = "calce-selected-catalog-garments";
const readSelectedCatalogGarments = () => {
  const savedSelection = sessionStorage.getItem(catalogSelectionStorageKey);
  if (!savedSelection) return [];
  const products = JSON.parse(savedSelection);
  if (!Array.isArray(products)) return [];
  return products.filter(product =>
    product &&
    typeof product.product_url === "string" &&
    product.product_url,
  );
};
const clearSelectedCatalogGarments = () => {
  try {
    sessionStorage.removeItem(catalogSelectionStorageKey);
  } catch (error) {
    console.error("No se pudo reiniciar la selección del catálogo.", error);
    return false;
  }
  window.dispatchEvent(new Event("calce:catalog-selection-cleared"));
  return true;
};

const sizeMeasureDefinitions = [
  { fieldName: "bust", label: "Busto", rangeKey: "Bust" },
  { fieldName: "waist", label: "Cintura", rangeKey: "Waist" },
  { fieldName: "hip", label: "Cadera", rangeKey: "Hip" },
];
const readEnteredSizeMeasures = () => sizeMeasureDefinitions.flatMap(
  ({ fieldName, label, rangeKey }) => {
    const field = document.querySelector(`[name="${fieldName}"]`);
    const value = Number.parseFloat(field?.value.replace(",", ".") ?? "");
    return Number.isFinite(value) && value > 0
      ? [{ value, label, rangeKey }]
      : [];
  },
);
let standardSizeElementsCache;
const standardSizeElements = () => {
  if (!standardSizeElementsCache) {
    standardSizeElementsCache = Array.from(
      document.querySelectorAll("[data-standard-size]"),
    );
  }
  return standardSizeElementsCache;
};
const recommendStandardSizeRanges = (
  enteredMeasures = readEnteredSizeMeasures(),
) => {
  const sizes = standardSizeElements();
  if (!enteredMeasures.length || !sizes.length) {
    return { sizes: [], exactMatch: false };
  }
  const rangesFor = size => enteredMeasures.map(({ value, rangeKey }) => {
    const minimum = Number(size.dataset[`size${rangeKey}Min`]);
    const maximum = Number(size.dataset[`size${rangeKey}Max`]);
    return {
      compatible: value >= minimum && value <= maximum,
      distance: Math.max(minimum - value, value - maximum, 0),
    };
  });
  const exactSizes = sizes.filter(
    size => rangesFor(size).every(range => range.compatible),
  );
  if (exactSizes.length) return { sizes: exactSizes, exactMatch: true };

  const distances = sizes.map(size => rangesFor(size)
    .reduce((total, range) => total + range.distance, 0));
  const minimumDistance = Math.min(...distances);
  return {
    sizes: sizes.filter((_, index) =>
      Math.abs(distances[index] - minimumDistance) < 1e-9,
    ),
    exactMatch: false,
  };
};
let parisSizeFitContextCache;
const getParisSizeFitContext = (enteredMeasures = readEnteredSizeMeasures()) => {
  const cacheKey = JSON.stringify(
    enteredMeasures.map(({ value, rangeKey }) => [rangeKey, value]),
  );
  if (parisSizeFitContextCache?.cacheKey === cacheKey) {
    return parisSizeFitContextCache;
  }
  const sizes = standardSizeElements();
  parisSizeFitContextCache = {
    cacheKey,
    sizes,
    standardLabels: new Set(
      sizes.map(size => normalizeSizeOption(size.dataset.sizeLabel || "")),
    ),
    recommendation: recommendStandardSizeRanges(enteredMeasures),
    descriptions: new Map(),
  };
  return parisSizeFitContextCache;
};
const normalizeSizeOption = size => size.trim().toLocaleUpperCase("es-CL")
  .replace(/\s+/g, "");
const getParisSizeFitDescription = (
  sizeLabel,
  fitContext = getParisSizeFitContext(),
) => {
  const normalizedLabel = normalizeSizeOption(sizeLabel);
  if (fitContext.descriptions.has(normalizedLabel)) {
    return fitContext.descriptions.get(normalizedLabel);
  }
  const { sizes, standardLabels, recommendation } = fitContext;
  const labelParts = normalizedLabel.split(/[/-]/).filter(Boolean);
  const isStandardAlphaRange = labelParts.length > 1
    && labelParts.every(part => standardLabels.has(part));
  const equivalentSizes = sizes.filter(size => {
    const standardLabel = normalizeSizeOption(size.dataset.sizeLabel || "");
    const european = normalizeSizeOption(size.dataset.sizeEu || "");
    const us = normalizeSizeOption(size.dataset.sizeUs || "");
    const europeanParts = european.split(/[/-]/).filter(Boolean);
    const usParts = us.split(/[/-]/).filter(Boolean);
    return normalizedLabel === standardLabel
      || normalizedLabel === european
      || normalizedLabel === us
      || (
        /^\d+$/.test(normalizedLabel)
        && (europeanParts.includes(normalizedLabel) || usParts.includes(normalizedLabel))
      )
      || (isStandardAlphaRange && labelParts.includes(standardLabel));
  });
  let description;
  if (!equivalentSizes.length) {
    description = "Sin equivalencia de medidas";
  } else if (!recommendation.sizes.length) {
    description = "Ingresa tus medidas";
  } else {
    const recommendedIndices = recommendation.sizes
      .map(size => sizes.indexOf(size))
      .filter(index => index >= 0);
    if (!recommendedIndices.length) {
      description = "Revisa el ajuste";
    } else {
      const smallestRecommendedIndex = Math.min(...recommendedIndices);
      const largestRecommendedIndex = Math.max(...recommendedIndices);
      const descriptions = new Set(equivalentSizes.map(size => {
        const index = sizes.indexOf(size);
        if (recommendation.exactMatch && recommendedIndices.includes(index)) {
          return "Podría quedarte bien";
        }
        if (
          recommendedIndices.includes(index)
          || Math.min(...recommendedIndices.map(value => Math.abs(index - value))) <= 1
        ) {
          return "Revisa el ajuste";
        }
        if (index > largestRecommendedIndex) return "Podría quedar holgada";
        if (index < smallestRecommendedIndex) return "Podría quedar estrecha";
        return "Revisa el ajuste";
      }));
      description = descriptions.size === 1
        ? descriptions.values().next().value
        : "Revisa el ajuste";
    }
  }
  fitContext.descriptions.set(normalizedLabel, description);
  return description;
};
const updateParisSizeSelect = (sizeSelect, fitContext) => {
  if (!sizeSelect || sizeSelect.tagName !== "SELECT") return;
  const context = fitContext || getParisSizeFitContext();
  Array.from(sizeSelect.options).forEach(option => {
    if (!option.value) return;
    if (option.disabled) {
      option.classList.add("catalog-size-unavailable");
      option.textContent = `${option.value} — Sin stock`;
      return;
    }
    option.classList.remove("catalog-size-unavailable");
    option.textContent =
      `${option.value} — ${getParisSizeFitDescription(option.value, context)}`;
  });
};
const refreshParisSizeSelects = () => {
  const fitContext = getParisSizeFitContext();
  document.querySelectorAll("select[data-catalog-size-choice]")
    .forEach(select => updateParisSizeSelect(select, fitContext));
};
document.querySelectorAll('[name="bust"], [name="waist"], [name="hip"]')
  .forEach(field => field.addEventListener("input", refreshParisSizeSelects));

(() => {
  const storageKey = "calce-shopping-cart";
  const status = document.querySelector("[data-cart-status]");
  const cartLink = document.querySelector(".cart-link");
  const countBadge = document.querySelector("[data-cart-count]");
  const cartPanel = document.querySelector('[data-page-panel="cart"]');
  const emptyState = cartPanel?.querySelector("[data-cart-empty]");
  const cartContent = cartPanel?.querySelector("[data-cart-content]");
  const cartList = cartPanel?.querySelector("[data-cart-items]");
  const itemCount = cartPanel?.querySelector("[data-cart-item-count]");
  const total = cartPanel?.querySelector("[data-cart-total]");
  const confirmation = cartPanel?.querySelector("[data-cart-confirmation]");
  const currency = new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  });

  const reportStorageError = error => {
    if (status) {
      status.textContent = "No se pudo guardar el carrito en este navegador.";
    }
    console.error("No se pudo acceder al carrito guardado.", error);
  };

  const normalizeCartItem = item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    try {
      const productUrl = new URL(item.product_url);
      if (productUrl.protocol !== "https:" || !item.title) return null;
      const imageUrl = typeof item.image_url === "string" && item.image_url
        ? new URL(item.image_url)
        : null;
      const price = item.price_clp;
      const quantity = item.quantity === undefined ? 1 : item.quantity;
      if (!Number.isSafeInteger(quantity) || quantity < 1) return null;
      return {
        product_url: productUrl.href,
        image_url: imageUrl?.protocol === "https:" ? imageUrl.href : "",
        store: typeof item.store === "string" ? item.store : "",
        brand: typeof item.brand === "string" ? item.brand : "",
        title: String(item.title),
        size: typeof item.size === "string" ? item.size : "",
        quantity,
        price_clp: Number.isFinite(price) && price >= 0 ? price : null,
      };
    } catch (error) {
      if (error instanceof TypeError) return null;
      throw error;
    }
  };

  const readCart = () => {
    try {
      const savedCart = localStorage.getItem(storageKey);
      if (!savedCart) return [];
      const parsedCart = JSON.parse(savedCart);
      if (!Array.isArray(parsedCart)) {
        throw new Error("El carrito guardado no es una lista.");
      }
      return parsedCart.map(normalizeCartItem).filter(Boolean);
    } catch (error) {
      reportStorageError(error);
      return [];
    }
  };

  let items = readCart();

  const updateAddButtons = () => {
    document.querySelectorAll("[data-cart-add]").forEach(button => {
      const card = button.closest("[data-catalog-card]");
      const productUrl = card?.querySelector(".catalog-buy-link")?.href;
      const inCart = items.some(item => item.product_url === productUrl);
      const title = card?.querySelector(".catalog-item-info h3")?.textContent?.trim();
      button.disabled = inCart;
      const quantityInput = card?.querySelector("[data-catalog-quantity]");
      const sizeInput = card?.querySelector("[data-catalog-size-choice]");
      if (quantityInput) quantityInput.disabled = inCart;
      if (sizeInput) sizeInput.disabled = inCart;
      const label = inCart
        ? `Ya está en el carrito: ${title || "esta prenda"}`
        : `Añadir ${title || "esta prenda"} al carrito`;
      button.setAttribute("aria-label", label);
      button.title = inCart ? label : "Añadir al carrito";
      const visibleLabel = button.querySelector(".catalog-cart-add-label");
      if (visibleLabel) {
        visibleLabel.textContent = inCart ? "En el carrito" : "Añadir al carrito";
      }
    });
  };

  const createElement = (tagName, className, text) => {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  const renderCart = () => {
    const count = items.reduce((sum, item) => sum + item.quantity, 0);
    if (countBadge) {
      countBadge.hidden = count === 0;
      countBadge.textContent = String(count);
    }
    if (cartLink) {
      cartLink.setAttribute(
        "aria-label",
        `Carrito de compras, ${count} ${count === 1 ? "producto" : "productos"}`,
      );
    }
    if (emptyState) emptyState.hidden = count !== 0;
    if (cartContent) cartContent.hidden = count === 0;
    if (itemCount) itemCount.textContent = String(count);
    if (total) {
      const hasUnknownPrice = items.some(item => item.price_clp === null);
      total.textContent = hasUnknownPrice
        ? "No disponible"
        : currency.format(items.reduce(
          (sum, item) => sum + item.price_clp * item.quantity,
          0,
        ));
    }

    if (cartList) {
      cartList.replaceChildren();
      items.forEach(item => {
        const row = createElement("article", "cart-item");
        const image = createElement("img");
        image.src = item.image_url || "/assets/calce-isotipo.png";
        image.alt = `Imagen referencial de ${item.title}`;
        row.append(image);

        const info = createElement("div", "cart-item-info");
        info.append(createElement(
          "span",
          "cart-item-store",
          [item.store, item.brand].filter(Boolean).join(" · "),
        ));
        info.append(createElement("h2", "", item.title));
        info.append(createElement(
          "span",
          "cart-item-size",
          `${item.store === "Vestua" ? "Talla publicada" : "Talla elegida"}: ${item.size || "No indicada"}`,
        ));
        info.append(createElement(
          "span",
          "cart-item-quantity",
          `Cantidad: ${item.quantity}`,
        ));
        info.append(createElement(
          "strong",
          "cart-item-price",
          item.price_clp === null
            ? "Precio no disponible"
            : `Subtotal: ${currency.format(item.price_clp * item.quantity)}`,
        ));
        row.append(info);

        const actions = createElement("div", "cart-item-actions");
        const storeLink = createElement("a", "", `Ver en ${item.store || "la tienda"}`);
        storeLink.href = item.product_url;
        storeLink.target = "_blank";
        storeLink.rel = "noopener noreferrer";
        actions.append(storeLink);
        const removeButton = createElement("button", "cart-item-remove", "Quitar");
        removeButton.type = "button";
        removeButton.dataset.cartRemove = item.product_url;
        removeButton.setAttribute("aria-label", `Quitar ${item.title} del carrito`);
        actions.append(removeButton);
        row.append(actions);
        cartList.append(row);
      });
    }
    updateAddButtons();
  };

  const saveCart = nextItems => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(nextItems));
      items = nextItems;
      if (confirmation) confirmation.hidden = true;
      renderCart();
      return true;
    } catch (error) {
      reportStorageError(error);
      return false;
    }
  };

  document.addEventListener("click", event => {
    if (!(event.target instanceof Element)) return;
    const addButton = event.target.closest("[data-cart-add]");
    if (addButton) {
      const card = addButton.closest("[data-catalog-card]");
      const productLink = card?.querySelector(".catalog-buy-link");
      const title = card?.querySelector(".catalog-item-info h3")?.textContent?.trim();
      if (!card || !productLink || !title) {
        if (status) status.textContent = "No se pudo identificar el producto.";
        return;
      }
      const productUrl = productLink.href;
      if (items.some(item => item.product_url === productUrl)) return;
      const quantityInput = card.querySelector("[data-catalog-quantity]");
      const sizeInput = card.querySelector("[data-catalog-size-choice]");
      const quantity = quantityInput ? Number(quantityInput.value) : 1;
      const size = sizeInput
        ? sizeInput.value.trim()
        : card.dataset.catalogSize || "";
      const selectedSizeOption = sizeInput?.tagName === "SELECT"
        ? sizeInput.selectedOptions[0]
        : null;
      if (!Number.isSafeInteger(quantity) || quantity < 1) {
        if (status) status.textContent = "Indica una cantidad válida (mínimo 1).";
        quantityInput?.focus();
        return;
      }
      if (sizeInput && (!size || selectedSizeOption?.disabled)) {
        if (status) {
          status.textContent = selectedSizeOption?.disabled
            ? `La talla ${size} no tiene stock.`
            : "Indica la talla que llevarás.";
        }
        sizeInput.focus();
        return;
      }
      const rawPrice = card.dataset.catalogPrice;
      const parsedPrice = rawPrice ? Number(rawPrice) : Number.NaN;
      const item = normalizeCartItem({
        product_url: productUrl,
        image_url: card.querySelector(".catalog-image")?.src || "",
        store: card.dataset.catalogStore || "",
        brand: card.dataset.catalogBrand || "",
        title,
        size,
        quantity,
        price_clp: Number.isFinite(parsedPrice) ? parsedPrice : null,
      });
      if (!item) {
        if (status) status.textContent = "No se pudo agregar este producto al carrito.";
        return;
      }
      if (!saveCart([...items, item])) return;
      if (status) status.textContent = `${title} se agregó al carrito.`;
      return;
    }

    const removeButton = event.target.closest("[data-cart-remove]");
    if (removeButton) {
      const productUrl = removeButton.dataset.cartRemove;
      saveCart(items.filter(item => item.product_url !== productUrl));
      return;
    }

    const confirmButton = event.target.closest("[data-cart-confirm]");
    if (confirmButton && confirmation) {
      confirmation.textContent =
        "Selección confirmada. No se generó una orden ni se realizó un pago. " +
        "Abre cada tienda desde «Ver en la tienda» para revisar disponibilidad y completar la compra.";
      confirmation.hidden = false;
    }
  });

  window.addEventListener("calce:add-to-cart", event => {
    const detail = event.detail;
    if (!detail || !Array.isArray(detail.products)) return;
    const normalizedProducts = detail.products
      .map(normalizeCartItem)
      .filter(Boolean);
    const knownUrls = new Set(items.map(item => item.product_url));
    const additions = normalizedProducts.filter(item => {
      if (knownUrls.has(item.product_url)) return false;
      knownUrls.add(item.product_url);
      return true;
    });
    detail.addedCount = additions.length;
    detail.invalidCount = detail.products.length - normalizedProducts.length;
    detail.saved = additions.length === 0 || saveCart([...items, ...additions]);
  });

  window.addEventListener("storage", event => {
    if (event.key !== storageKey) return;
    items = readCart();
    renderCart();
  });

  window.addEventListener("calce:catalog-cards-rendered", updateAddButtons);

  renderCart();
})();

(() => {
  const storageKey = "calce-favorite-products";
  const catalogStatus = document.querySelector("[data-catalog-favorite-status]");
  const favoritesPanel = document.querySelector('[data-page-panel="favorites"]');
  const favoritesStatus = favoritesPanel?.querySelector("[data-favorites-status]");
  const favoritesList = favoritesPanel?.querySelector("[data-favorites-list]");
  const favoritesEmpty = favoritesPanel?.querySelector("[data-favorites-empty]");
  const currency = new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  });

  const setStatus = message => {
    const status = favoritesPanel && !favoritesPanel.hidden
      ? favoritesStatus
      : catalogStatus;
    if (status) status.textContent = message;
  };
  const reportStorageError = (message, error) => {
    setStatus(message);
    console.error(message, error);
  };
  const normalizeProduct = product => {
    if (!product || typeof product !== "object" || Array.isArray(product)) return null;
    try {
      const productUrl = new URL(product.product_url);
      if (
        productUrl.protocol !== "https:"
        || typeof product.title !== "string"
        || !product.title.trim()
      ) {
        return null;
      }
      let imageUrl = "";
      if (typeof product.image_url === "string" && product.image_url) {
        try {
          const parsedImageUrl = new URL(product.image_url);
          if (parsedImageUrl.protocol === "https:") {
            imageUrl = parsedImageUrl.href;
          }
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
        }
      }
      return {
        product_url: productUrl.href,
        image_url: imageUrl,
        store: typeof product.store === "string" ? product.store : "",
        brand: typeof product.brand === "string" ? product.brand : "",
        title: product.title,
        size: typeof product.size === "string" ? product.size : "",
        type: typeof product.type === "string" ? product.type : "",
        fit_label: typeof product.fit_label === "string" ? product.fit_label : "",
        fit_badge: typeof product.fit_badge === "string" ? product.fit_badge : "",
        fit_badge_class: ["tight", "loose", "partial"].includes(product.fit_badge_class)
          ? product.fit_badge_class
          : "partial",
        available_sizes: Array.isArray(product.available_sizes)
          ? Array.from(new Set(
            product.available_sizes
              .filter(size => typeof size === "string" && size.trim())
              .map(size => size.trim()),
          ))
          : [],
        out_of_stock_sizes: Array.isArray(product.out_of_stock_sizes)
          ? Array.from(new Set(
            product.out_of_stock_sizes
              .filter(size => typeof size === "string" && size.trim())
              .map(size => size.trim()),
          ))
          : [],
        price_clp: Number.isFinite(product.price_clp) && product.price_clp >= 0
          ? product.price_clp
          : null,
      };
    } catch (error) {
      if (error instanceof TypeError) return null;
      throw error;
    }
  };
  const readFavorites = () => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (!saved) return [];
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) throw new Error("Favoritos no es una lista.");
      return parsed.map(normalizeProduct).filter(Boolean);
    } catch (error) {
      reportStorageError("No se pudieron leer tus Favoritos.", error);
      return [];
    }
  };

  let favorites = readFavorites();

  const createHeartButton = product => {
    const button = document.createElement("button");
    button.className = "catalog-favorite-toggle";
    button.type = "button";
    button.dataset.favoriteToggle = "";
    button.dataset.productUrl = product.product_url;
    button.dataset.productTitle = product.title;
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("focusable", "false");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M20.8 4.6a5.6 5.6 0 0 0-7.9 0L12 5.5l-.9-.9a5.6 5.6 0 0 0-7.9 7.9L12 21l8.8-8.5a5.6 5.6 0 0 0 0-7.9z",
    );
    icon.append(path);
    const hiddenLabel = document.createElement("span");
    hiddenLabel.className = "visually-hidden";
    hiddenLabel.textContent = "Quitar de Favoritos";
    button.append(icon, hiddenLabel);
    return button;
  };

  const createCartButton = product => {
    const button = document.createElement("button");
    button.className = "catalog-cart-add";
    button.type = "button";
    button.dataset.cartAdd = "";
    button.title = "Añadir al carrito";
    button.setAttribute("aria-label", `Añadir ${product.title} al carrito`);
    const label = document.createElement("span");
    label.className = "catalog-cart-add-label";
    label.textContent = "Añadir al carrito";
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("focusable", "false");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M3 4h2l2.2 11.1a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 1.9-1.4L22 9H7",
    );
    const frontWheel = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    frontWheel.setAttribute("cx", "10");
    frontWheel.setAttribute("cy", "20");
    frontWheel.setAttribute("r", "1.25");
    const backWheel = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    backWheel.setAttribute("cx", "18");
    backWheel.setAttribute("cy", "20");
    backWheel.setAttribute("r", "1.25");
    icon.append(path, frontWheel, backWheel);
    button.append(label, icon);
    return button;
  };

  const createPurchaseControls = product => {
    if (product.store === "Vestua") return null;
    const controls = document.createElement("div");
    controls.className = "catalog-purchase-controls";

    const quantityLabel = document.createElement("label");
    quantityLabel.className = "catalog-purchase-field";
    const quantityCaption = document.createElement("span");
    quantityCaption.textContent = "Cantidad";
    const quantityInput = document.createElement("input");
    quantityInput.type = "number";
    quantityInput.min = "1";
    quantityInput.step = "1";
    quantityInput.value = "1";
    quantityInput.inputMode = "numeric";
    quantityInput.dataset.catalogQuantity = "";
    quantityLabel.append(quantityCaption, quantityInput);

    const sizeLabel = document.createElement("label");
    sizeLabel.className = "catalog-purchase-field";
    const sizeCaption = document.createElement("span");
    sizeCaption.textContent = "Talla a llevar";
    sizeLabel.append(sizeCaption);
    if (product.store === "Paris" && product.available_sizes.length) {
      const sizeSelect = document.createElement("select");
      sizeSelect.dataset.catalogSizeChoice = "";
      sizeSelect.required = true;
      const outOfStockSizes = new Set(
        product.out_of_stock_sizes.map(normalizeSizeOption),
      );
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Selecciona una talla";
      placeholder.disabled = true;
      placeholder.selected = true;
      sizeSelect.append(placeholder);
      product.available_sizes.forEach(size => {
        const option = document.createElement("option");
        option.value = size;
        option.textContent = size;
        option.disabled = outOfStockSizes.has(normalizeSizeOption(size));
        sizeSelect.append(option);
      });
      updateParisSizeSelect(sizeSelect);
      sizeLabel.append(sizeSelect);
    } else {
      const sizeInput = document.createElement("input");
      sizeInput.type = "text";
      sizeInput.maxLength = 32;
      sizeInput.autocomplete = "off";
      sizeInput.placeholder = "Ej.: M";
      sizeInput.required = true;
      sizeInput.dataset.catalogSizeChoice = "";
      sizeLabel.append(sizeInput);
    }

    controls.append(quantityLabel, sizeLabel);
    return controls;
  };

  const updateFavoriteButtons = () => {
    document.querySelectorAll("[data-favorite-toggle]").forEach(button => {
      const card = button.closest("[data-catalog-card]");
      const productUrl = button.dataset.productUrl
        || card?.querySelector(".catalog-buy-link")?.href;
      const productTitle = button.dataset.productTitle
        || card?.querySelector(".catalog-item-info h3")?.textContent?.trim()
        || "esta prenda";
      if (!productUrl) return;
      button.dataset.productUrl = productUrl;
      button.dataset.productTitle = productTitle;
      const isFavorite = favorites.some(
        favorite => favorite.product_url === productUrl,
      );
      button.setAttribute("aria-pressed", String(isFavorite));
      const label = isFavorite
        ? `Quitar ${productTitle} de Favoritos`
        : `Agregar ${productTitle} a Favoritos`;
      button.setAttribute("aria-label", label);
      button.title = label;
      const hiddenLabel = button.querySelector(".visually-hidden");
      if (hiddenLabel) hiddenLabel.textContent = label;
    });
  };

  const renderFavorites = () => {
    if (!favoritesList) return;
    favoritesList.replaceChildren();
    favorites.forEach(product => {
      const card = document.createElement("article");
      card.className = "catalog-item favorite-item";
      card.dataset.catalogCard = "";
      card.dataset.catalogSize = product.size || "No indicada";
      card.dataset.catalogStore = product.store;
      card.dataset.catalogBrand = product.brand;
      card.dataset.catalogPrice = product.price_clp === null
        ? ""
        : String(product.price_clp);
      card.dataset.catalogType = product.type;
      card.dataset.catalogFitLabel = product.fit_label;
      card.dataset.catalogFitBadge = product.fit_badge;
      const media = document.createElement("div");
      media.className = "catalog-product-media";
      const link = document.createElement("a");
      link.className = "catalog-product-link";
      link.href = product.product_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const image = document.createElement("img");
      image.className = "catalog-image";
      image.src = product.image_url || "/assets/calce-isotipo.png";
      image.alt = `Imagen referencial de ${product.title}`;
      image.loading = "lazy";
      link.append(image);
      media.append(link, createHeartButton(product));

      const selectionRow = document.createElement("div");
      selectionRow.className = "catalog-card-selection-row";
      const fitBadge = document.createElement("span");
      fitBadge.className = `catalog-fit-badge ${product.fit_badge_class}`;
      fitBadge.textContent = product.fit_badge || "Sin referencia de calce";
      selectionRow.append(fitBadge);

      const info = document.createElement("div");
      info.className = "catalog-item-info";
      const store = document.createElement("span");
      store.className = "catalog-brand";
      store.textContent = [product.store, product.brand, product.type]
        .filter(Boolean)
        .join(" · ");
      const title = document.createElement("h3");
      title.textContent = product.title;
      const size = document.createElement("span");
      size.className = "catalog-product-size";
      size.textContent = `Talla publicada: ${product.size || "No indicada"}`;
      const price = document.createElement("strong");
      price.className = "catalog-price";
      price.textContent = product.price_clp === null
        ? "Precio no disponible"
        : currency.format(product.price_clp);
      const purchaseControls = createPurchaseControls(product);
      const cartButton = createCartButton(product);
      const storeLink = document.createElement("a");
      storeLink.className = "catalog-buy-link";
      storeLink.href = product.product_url;
      storeLink.target = "_blank";
      storeLink.rel = "noopener noreferrer";
      storeLink.textContent = `Ver ficha en ${product.store || "la tienda"}`;
      info.append(store, title);
      if (product.store !== "Paris") info.append(size);
      info.append(price);
      if (purchaseControls) info.append(purchaseControls);
      info.append(cartButton);
      info.append(storeLink);
      card.append(media, selectionRow, info);
      favoritesList.append(card);
    });
    if (favoritesEmpty) favoritesEmpty.hidden = favorites.length > 0;
    window.dispatchEvent(new CustomEvent("calce:catalog-cards-rendered"));
  };

  const saveFavorites = nextFavorites => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(nextFavorites));
    } catch (error) {
      reportStorageError("No se pudieron guardar tus Favoritos en este navegador.", error);
      return false;
    }
    favorites = nextFavorites;
    renderFavorites();
    updateFavoriteButtons();
    return true;
  };

  document.addEventListener("click", event => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-favorite-toggle]");
    if (!button) return;
    event.preventDefault();

    const card = button.closest("[data-catalog-card]");
    const productUrl = button.dataset.productUrl
      || card?.querySelector(".catalog-buy-link")?.href;
    const existingIndex = favorites.findIndex(
      favorite => favorite.product_url === productUrl,
    );
    const product = existingIndex >= 0
      ? favorites[existingIndex]
      : (() => {
        const sourceSizeSelect = card?.querySelector("select[data-catalog-size-choice]");
        const sourceFitBadge = card?.querySelector(".catalog-fit-badge");
        return normalizeProduct({
          product_url: productUrl,
          image_url: card?.querySelector(".catalog-image")?.src || "",
          store: card?.dataset.catalogStore || "",
          brand: card?.dataset.catalogBrand || "",
          title: button.dataset.productTitle
            || card?.querySelector(".catalog-item-info h3")?.textContent?.trim(),
          size: card?.dataset.catalogSize || "",
          type: card?.dataset.catalogType || "",
          fit_label: card?.dataset.catalogFitLabel || "",
          fit_badge: card?.dataset.catalogFitBadge || "",
          fit_badge_class: ["tight", "loose", "partial"].find(
            className => sourceFitBadge?.classList.contains(className),
          ) || "partial",
          available_sizes: sourceSizeSelect
            ? Array.from(sourceSizeSelect.options, option => option.value).filter(Boolean)
            : [],
          out_of_stock_sizes: sourceSizeSelect
            ? Array.from(sourceSizeSelect.options)
              .filter(option => option.value.trim() && option.disabled)
              .map(option => option.value)
            : [],
          price_clp: card?.dataset.catalogPrice
            ? Number(card.dataset.catalogPrice)
            : null,
        });
      })();
    if (!product) {
      setStatus("No se pudo identificar la prenda para guardarla en Favoritos.");
      console.error("No se pudo crear el elemento de Favoritos.", productUrl);
      return;
    }
    const nextFavorites = existingIndex >= 0
      ? favorites.filter(favorite => favorite.product_url !== productUrl)
      : [...favorites, product];
    if (saveFavorites(nextFavorites)) {
      setStatus(existingIndex >= 0
        ? `${product.title} se quitó de Favoritos.`
        : `${product.title} se agregó a Favoritos.`);
    }
  });

  window.addEventListener("calce:catalog-cards-rendered", updateFavoriteButtons);
  window.addEventListener("storage", event => {
    if (event.key !== storageKey) return;
    favorites = readFavorites();
    renderFavorites();
    updateFavoriteButtons();
  });

  renderFavorites();
  updateFavoriteButtons();
})();

document.querySelectorAll(".product-image").forEach(image => {
  image.addEventListener("error", () => {
    const link = image.closest(".product-image-link");
    if (!link) return;

    const placeholder = document.createElement("div");
    placeholder.className = "product-image-placeholder";
    placeholder.setAttribute("role", "img");
    placeholder.setAttribute("aria-label", "Foto de referencia de Vestua no disponible");
    placeholder.textContent = "Foto de referencia no disponible";
    link.replaceWith(placeholder);
  }, { once: true });
});

const startupDialogs = Array.from(document.querySelectorAll("[data-startup-dialog]"));

const showStartupDialog = index => {
  if (index >= startupDialogs.length) return;
  const dialog = startupDialogs[index];
  let dismissTimer;
  let closeTimer;
  let isDismissing = false;
  const dismissDialog = () => {
    if (!dialog.open || isDismissing) return;
    isDismissing = true;
    window.clearTimeout(dismissTimer);
    dialog.classList.add("is-dismissing");
    closeTimer = window.setTimeout(() => {
      dialog.close();
      dialog.classList.remove("is-dismissing");
      showStartupDialog(index + 1);
    }, 700);
  };

  dialog.addEventListener("cancel", event => {
    event.preventDefault();
    dismissDialog();
  }, { once: true });
  dialog.addEventListener("click", event => {
    if (event.target === dialog) dismissDialog();
  }, { once: true });
  dialog.showModal();
  dismissTimer = window.setTimeout(dismissDialog, 2000);
  dialog.addEventListener("close", () => {
    window.clearTimeout(dismissTimer);
    window.clearTimeout(closeTimer);
  }, { once: true });
};

const startupVisitKey = "medidas-startup-dialog-seen";
const navigationType = performance.getEntriesByType("navigation")[0]?.type;
const shouldShowStartupDialogs = (
  sessionStorage.getItem(startupVisitKey) !== "true"
  || navigationType === "reload"
);
if (startupDialogs.length && shouldShowStartupDialogs && !document.getElementById("style-wizard")) {
  sessionStorage.setItem(startupVisitKey, "true");
  showStartupDialog(0);
}

const scrollPositionKey = "medidas-scroll-position";
const savedScrollPosition = sessionStorage.getItem(scrollPositionKey);
if (savedScrollPosition !== null) {
  sessionStorage.removeItem(scrollPositionKey);
  const scrollPosition = Number(savedScrollPosition);
  if (Number.isFinite(scrollPosition)) {
    requestAnimationFrame(() => window.scrollTo(0, scrollPosition));
  }
}

const syncCatalogLinkMeasurements = () => {
  const measurementValues = Array.from(
    document.querySelectorAll('[data-style-wizard-form] .measurement-input[name]'),
    field => [field.name, field.value.trim()],
  );
  document.querySelectorAll('a[href]').forEach(link => {
    const url = new URL(link.href, window.location.href);
    if (
      url.origin !== window.location.origin
      || url.searchParams.get("view") !== "catalog"
    ) return;
    measurementValues.forEach(([name, value]) => {
      if (value) url.searchParams.set(name, value);
      else url.searchParams.delete(name);
    });
    link.href = `${url.pathname}${url.search}${url.hash}`;
  });
};

document.querySelectorAll('form[action="/"]').forEach(form => {
  const rememberCheckbox = form.querySelector("#remember-me");
  const rememberStatus = form.querySelector("#remember-status");
  const measurementFields = Array.from(
    form.querySelectorAll('.measurement-input[name]')
  );
  const rememberedEnabledKey = "medidas-remember-enabled";
  const rememberedValuesKey = "medidas-remember-values";
  const isCatalogView = new URLSearchParams(window.location.search).get("view") === "catalog";
  const isStyleWizardForm = form.matches("[data-style-wizard-form]");

  const showRememberStatus = message => {
    if (rememberStatus) rememberStatus.textContent = message;
  };
  const showPhotoRememberStatus = message => {
    const photoStatus = document.getElementById("matices-remember-status");
    if (photoStatus) photoStatus.textContent = message;
  };
  const readMeasurementValues = () => Object.fromEntries(
    measurementFields.map(field => [field.name, field.value])
  );
  const saveMeasurements = () => {
    localStorage.setItem(rememberedEnabledKey, "true");
    localStorage.setItem(rememberedValuesKey, JSON.stringify(readMeasurementValues()));
  };

  if (rememberCheckbox) {
    try {
      rememberCheckbox.checked = localStorage.getItem(rememberedEnabledKey) === "true";
      const storedValues = localStorage.getItem(rememberedValuesKey);
      const currentValues = readMeasurementValues();
      const hasCurrentMeasurement = Object.values(currentValues).some(Boolean);
      if (
        rememberCheckbox.checked
        && storedValues
        && window.calceAuthenticated === true
      ) {
        const parsedValues = JSON.parse(storedValues);
        if (!parsedValues || typeof parsedValues !== "object" || Array.isArray(parsedValues)) {
          throw new Error("Las medidas recordadas tienen un formato inválido.");
        }
        if (!isCatalogView) {
          measurementFields.forEach(field => {
            if (!field.value && typeof parsedValues[field.name] === "string") {
              field.value = parsedValues[field.name];
            }
          });
          if (!isStyleWizardForm && Object.values(readMeasurementValues()).some(Boolean)) {
            form.requestSubmit();
          }
        }
      }
    } catch (error) {
      rememberCheckbox.checked = false;
      showRememberStatus("No se pudieron recuperar las medidas guardadas.");
      console.error("No se pudieron recuperar las medidas guardadas.", error);
    }

    rememberCheckbox.addEventListener("change", () => {
      try {
        if (rememberCheckbox.checked) {
          saveMeasurements();
          showRememberStatus("Medidas guardadas en este navegador.");
        } else {
          try {
            localStorage.removeItem(rememberedEnabledKey);
            localStorage.removeItem(rememberedValuesKey);
          } catch (error) {
            console.error("No se pudieron eliminar las medidas locales de una sesión anónima.", error);
          }
          showRememberStatus("Se borraron las medidas guardadas.");
        }
      } catch (error) {
        showRememberStatus("No se pudieron guardar las medidas en este navegador.");
        console.error("No se pudieron actualizar las medidas guardadas.", error);
      }
    });
  }

  form.addEventListener("submit", () => {
    if (!isStyleWizardForm) {
      sessionStorage.setItem(scrollPositionKey, String(window.scrollY));
    }
    if (rememberCheckbox?.checked) {
      try {
        saveMeasurements();
        showRememberStatus("Medidas guardadas en este navegador.");
      } catch (error) {
        showRememberStatus("No se pudieron guardar las medidas en este navegador.");
        console.error("No se pudieron guardar las medidas.", error);
      }
    }
  });
  form.querySelectorAll('input[name], select[name]').forEach(field => {
    field.addEventListener("change", () => {
      if (!isStyleWizardForm) form.requestSubmit();
    });
  });

  measurementFields.forEach(field => {
    field.addEventListener("input", () => {
      syncCatalogLinkMeasurements();
      if (!rememberCheckbox.checked) return;
      try {
        saveMeasurements();
        showRememberStatus("Medidas guardadas en este navegador.");
      } catch (error) {
        showRememberStatus("No se pudieron guardar las medidas en este navegador.");
        console.error("No se pudieron guardar las medidas.", error);
      }
    });
  });

  const accountStatus = document.getElementById("supabase-auth-status");
  if (accountStatus && isStyleWizardForm) {
    const emailInput = document.getElementById("supabase-email");
    const passwordInput = document.getElementById("supabase-password");
    const signUpNameInput = document.getElementById("supabase-name");
    const signUpLastNameInput = document.getElementById("supabase-last-name");
    const confirmPasswordInput = document.getElementById("supabase-password-confirm");
    const passwordToggleButtons = Array.from(
      document.querySelectorAll("[data-password-toggle]"),
    );
    const rememberSessionInput = document.getElementById("supabase-remember-session");
    const rememberSessionRow = document.querySelector("[data-remember-session-row]");
    const rememberPhotoInput = document.getElementById("matices-remember");
    const confirmPasswordLabel = document.querySelector(".supabase-confirm-password");
    const authForm = document.querySelector("[data-supabase-auth-form]");
    const authModeButtons = Array.from(document.querySelectorAll("[data-auth-mode]"));
    const signInButton = document.querySelector("[data-supabase-sign-in]");
    const signUpButton = document.querySelector("[data-supabase-sign-up]");
    const signOutButton = document.querySelector("[data-supabase-sign-out]");
    const profileMenu = document.querySelector("[data-profile-menu]");
    const profileGreeting = document.querySelector("[data-profile-greeting]");
    const profileEmail = document.querySelector("[data-profile-email]");
    const profileEditLink = document.querySelector("[data-profile-edit]");
    const profileAccountLink = document.querySelector("[data-profile-account]");
    const profileFavoritesLink = document.querySelector("[data-profile-favorites]");
    const profilePaymentLink = document.querySelector("[data-profile-payment]");
    const navAccountLinks = document.querySelector(".nav-account-links");
    const profileName = document.querySelector("[data-profile-name]");
    const profileAvatar = document.querySelector("[data-profile-avatar]");
    const profileAvatarPreview = document.querySelector("[data-profile-avatar-preview]");
    const profileAvatarInput = document.getElementById("profile-avatar-input");
    const removeProfileAvatarButton = document.querySelector(
      "[data-remove-profile-avatar]",
    );
    const profileEmailInput = document.getElementById("profile-email");
    const profileFirstNameInput = document.getElementById("profile-first-name");
    const profileLastNameInput = document.getElementById("profile-last-name");
    const profilePhoneInput = document.getElementById("profile-phone");
    const profileDataStatus = document.querySelector("[data-profile-data-status]");
    const saveProfileDataButton = document.querySelector("[data-save-profile-data]");
    const profileBustInput = document.getElementById("profile-bust");
    const profileWaistInput = document.getElementById("profile-waist");
    const profileHipInput = document.getElementById("profile-hip");
    const profileAvatarFallbacks = Array.from(
      document.querySelectorAll("[data-profile-avatar-fallback]"),
    );
    const accountLinks = Array.from(document.querySelectorAll("[data-open-account]"));
    const supabaseUrl = document.querySelector('meta[name="supabase-url"]')?.content;
    const supabaseKey = document.querySelector('meta[name="supabase-publishable-key"]')?.content;
    let supabaseClient;
    window.calceGetAccessToken = async () => {
      if (!supabaseClient) return null;
      const { data, error } = await supabaseClient.auth.getSession();
      if (error) throw error;
      return data.session?.access_token ?? null;
    };
    let signedInUser;
    let activeUserId;
    let profileLoadedUserId;
    let latestSelectedPhoto;
    let pendingPhotoRemember;
    let rememberedPhotoPath;
    let profilePhotoSyncQueue = Promise.resolve();
    let cloudSaveTimer;
    const profilePhotoBucket = "user-profile-photos";
    const profilePhotoPath = user => `${user.id}/remembered-photo`;
    const profileAvatarPath = user => `${user.id}/avatar`;
    let profileAvatarPathValue;
    let profileAvatarUrl;
    const renderProfileAvatar = source => {
      [profileAvatar, profileAvatarPreview].forEach(image => {
        image.hidden = !source;
        if (source) image.src = source;
        else image.removeAttribute("src");
      });
      profileAvatarFallbacks.forEach(fallback => {
        fallback.hidden = Boolean(source);
      });
      if (removeProfileAvatarButton) {
        removeProfileAvatarButton.hidden = !source;
      }
    };
    let savedProfileFirstName = "";
    let savedProfileLastName = "";
    const profileFields = [
      profileFirstNameInput, profileLastNameInput,
      profilePhoneInput, profileBustInput, profileWaistInput, profileHipInput,
    ].filter(Boolean);
    const requestedReturnView = new URLSearchParams(window.location.search).get("return_view");
    let authReturnView = ["storefront", "home", "try-on", "profile"].includes(requestedReturnView)
      ? requestedReturnView
      : "storefront";
    let returnToHomeAfterSignIn = false;
    let authMode = new URLSearchParams(window.location.search).get("auth_mode") === "sign-up"
      ? "sign-up"
      : "sign-in";

    const showAccountStatus = message => {
      accountStatus.textContent = message;
    };
    const setPasswordVisibility = (input, button, visible) => {
      input.type = visible ? "text" : "password";
      button.textContent = visible ? "Ocultar" : "Mostrar";
      button.setAttribute(
        "aria-label",
        `${visible ? "Ocultar" : "Mostrar"} contraseña`,
      );
      button.setAttribute("aria-pressed", String(visible));
    };
    passwordToggleButtons.forEach(button => {
      const input = document.getElementById(button.dataset.passwordToggle);
      if (!input) {
        console.error("No se encontró el campo de contraseña asociado al control.");
        button.disabled = true;
        return;
      }
      button.addEventListener("click", () => {
        setPasswordVisibility(input, button, input.type === "password");
      });
    });
    const updateProfileGreeting = (firstName, lastName) => {
      if (!profileGreeting) return;
      const fullName = [firstName, lastName]
        .filter(value => typeof value === "string")
        .map(value => value.trim())
        .filter(Boolean)
        .join(" ");
      profileGreeting.textContent = fullName ? `Bienvenido\n${fullName}` : "Bienvenido";
    };
    const setAuthControls = user => {
      window.calceAuthenticated = Boolean(user);
      authForm.hidden = Boolean(user);
      profileMenu.hidden = !user;
      profileGreeting.hidden = !user;
      signOutButton.hidden = !user;
      profileEditLink.hidden = !user;
      profileAccountLink.hidden = !user;
      if (profileFavoritesLink) profileFavoritesLink.hidden = !user;
      profilePaymentLink.hidden = !user;
      profileEmail.hidden = !user;
      profileEmail.textContent = user?.email || "Cuenta activa";
      navAccountLinks.hidden = Boolean(user);
      profileFields.forEach(field => { field.disabled = !user; });
      if (rememberCheckbox) rememberCheckbox.disabled = !user;
      if (rememberPhotoInput) rememberPhotoInput.disabled = !user;
      profileName.textContent = user?.user_metadata?.first_name
        || user?.email || "Mi Perfil";
      updateProfileGreeting(
        user?.user_metadata?.first_name,
        user?.user_metadata?.last_name,
      );
      if (profileEmailInput) {
        profileEmailInput.disabled = true;
        profileEmailInput.value = user?.email || "";
      }
      if (saveProfileDataButton) saveProfileDataButton.disabled = !user;
      if (!user) {
        profileAvatarPathValue = null;
        if (profileAvatarUrl) URL.revokeObjectURL(profileAvatarUrl);
        profileAvatarUrl = null;
        renderProfileAvatar(null);
        profileFields.forEach(field => { field.value = ""; });
        if (profileEmailInput) profileEmailInput.value = "";
        profileName.textContent = "Mi Perfil";
      }
      accountLinks.forEach(link => {
        link.hidden = Boolean(user);
      });
      emailInput.disabled = Boolean(user);
      passwordInput.disabled = Boolean(user);
      confirmPasswordInput.disabled = Boolean(user);
      passwordToggleButtons.forEach(button => {
        const input = document.getElementById(button.dataset.passwordToggle);
        if (input) setPasswordVisibility(input, button, false);
        button.disabled = Boolean(user);
      });
      rememberSessionInput.disabled = Boolean(user);
      authModeButtons.forEach(button => {
        button.disabled = Boolean(user);
      });
    };
    const redirectUnauthenticatedView = () => {
      const view = new URLSearchParams(window.location.search).get("view");
      if (!["home", "try-on", "profile"].includes(view)) return;
      authReturnView = view;
      const accountQuery = new URLSearchParams({
        view: "account",
        auth_mode: "sign-in",
        return_view: view,
      });
      window.location.replace(`/?${accountQuery}`);
    };
    const setAuthMode = mode => {
      authMode = mode;
      const creatingAccount = mode === "sign-up";
      authModeButtons.forEach(button => {
        const isActive = button.dataset.authMode === mode;
        button.classList.toggle("is-active", isActive);
        button.setAttribute("aria-pressed", String(isActive));
      });
      accountLinks.forEach(link => {
        if (link.dataset.openAccount === mode) {
          link.setAttribute("aria-current", "page");
        } else {
          link.removeAttribute("aria-current");
        }
      });
      confirmPasswordLabel.hidden = !creatingAccount;
      confirmPasswordInput.required = creatingAccount;
      confirmPasswordInput.disabled = !creatingAccount || Boolean(signedInUser);
      document.querySelectorAll("[data-sign-up-only]").forEach(label => {
        label.hidden = !creatingAccount;
        const input = label.querySelector("input");
        if (input) {
          input.disabled = !creatingAccount || Boolean(signedInUser);
          input.required = creatingAccount;
        }
      });
      rememberSessionRow.hidden = creatingAccount;
      signInButton.hidden = creatingAccount;
      signUpButton.hidden = !creatingAccount;
      passwordInput.autocomplete = creatingAccount ? "new-password" : "current-password";
    };
    const authStorage = {
      getItem: async key => {
        const persistentSession = window.localStorage.getItem(key);
        if (persistentSession !== null) {
          rememberSessionInput.checked = true;
          return persistentSession;
        }
        return window.sessionStorage.getItem(key);
      },
      setItem: async (key, value) => {
        const selectedStorage = rememberSessionInput.checked
          ? window.localStorage
          : window.sessionStorage;
        const otherStorage = rememberSessionInput.checked
          ? window.sessionStorage
          : window.localStorage;
        selectedStorage.setItem(key, value);
        otherStorage.removeItem(key);
      },
      removeItem: async key => {
        window.localStorage.removeItem(key);
        window.sessionStorage.removeItem(key);
      },
    };
    const readPalette = () => {
      try {
        const palette = JSON.parse(sessionStorage.getItem("matices-wizard-palette") || "[]");
        return Array.isArray(palette) ? palette : [];
      } catch (error) {
        console.error("No se pudo leer la paleta para sincronizarla.", error);
        return [];
      }
    };
    const saveProfile = async (
      persistMeasurements = false,
      commitProfileName = false,
    ) => {
      if (
        !supabaseClient
        || !signedInUser
        || profileLoadedUserId !== signedInUser.id
      ) return;
      const rememberPhoto = rememberPhotoInput?.checked === true;
      const rememberMeasurements = (
        persistMeasurements || rememberCheckbox?.checked === true || rememberPhoto
      );
      const measurements = Object.fromEntries(measurementFields.map(field => [
        field.name,
        rememberMeasurements && field.value ? Number(field.value) : null,
      ]));
      const phoneDigits = (profilePhoneInput?.value || "").replace(/\D/g, "");
      if (phoneDigits && phoneDigits.length !== 8) {
        throw new Error("Ingresa los 8 dígitos de tu teléfono chileno.");
      }
      const firstName = commitProfileName
        ? profileFirstNameInput?.value.trim() || ""
        : savedProfileFirstName;
      const lastName = commitProfileName
        ? profileLastNameInput?.value.trim() || ""
        : savedProfileLastName;
      const { error } = await supabaseClient
        .from("user_profiles")
        .upsert({
          user_id: signedInUser.id,
          first_name: firstName || null,
          last_name: lastName || null,
          phone: phoneDigits
            ? `+56 9 ${phoneDigits.slice(0, 4)} ${phoneDigits.slice(4)}`
            : null,
          bust: persistMeasurements && profileBustInput?.value
            ? Number(profileBustInput.value)
            : measurements.bust,
          waist: persistMeasurements && profileWaistInput?.value
            ? Number(profileWaistInput.value)
            : measurements.waist,
          hip: persistMeasurements && profileHipInput?.value
            ? Number(profileHipInput.value)
            : measurements.hip,
          remember_measurements: rememberMeasurements,
          remember_photo: rememberPhoto,
          photo_path: rememberPhoto ? rememberedPhotoPath : null,
          avatar_path: profileAvatarPathValue || null,
          color_palette: rememberMeasurements ? readPalette() : [],
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" });
      if (error) throw error;
      if (commitProfileName) {
        savedProfileFirstName = firstName;
        savedProfileLastName = lastName;
        profileName.textContent = firstName || signedInUser.email || "Mi Perfil";
        updateProfileGreeting(firstName, lastName);
      }
      return true;
    };
    const scheduleProfileSave = () => {
      window.clearTimeout(cloudSaveTimer);
      cloudSaveTimer = window.setTimeout(() => {
        saveProfile().catch(error => {
          showRememberStatus("No se pudieron sincronizar tus datos con Supabase.");
          console.error("No se pudo guardar el perfil en Supabase.", error);
        });
      }, 400);
    };
    const uploadProfilePhoto = async (user, file) => {
      const allowedTypes = new Set([
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        "image/avif",
      ]);
      if (!allowedTypes.has(file.type)) {
        throw new Error("La foto debe estar en formato JPEG, PNG, WebP, GIF o AVIF.");
      }
      if (file.size > 10 * 1024 * 1024) {
        throw new Error("La foto supera el límite de 10 MB.");
      }
      const { error } = await supabaseClient.storage
        .from(profilePhotoBucket)
        .upload(profilePhotoPath(user), file, {
          cacheControl: "3600",
          contentType: file.type,
          upsert: true,
        });
      if (error) throw error;
      return profilePhotoPath(user);
    };
    const deleteProfilePhoto = async user => {
      const { error } = await supabaseClient.storage
        .from(profilePhotoBucket)
        .remove([profilePhotoPath(user)]);
      if (error) throw error;
    };
    const loadProfileAvatar = async (user, path) => {
      if (!path) {
        if (profileAvatarUrl) URL.revokeObjectURL(profileAvatarUrl);
        profileAvatarUrl = null;
        renderProfileAvatar(null);
        return;
      }
      if (path !== profileAvatarPath(user)) {
        throw new Error("La ruta de la foto de perfil no es válida.");
      }
      const { data, error } = await supabaseClient.storage
        .from(profilePhotoBucket)
        .createSignedUrl(path, 3600);
      if (error) throw error;
      if (profileAvatarUrl) URL.revokeObjectURL(profileAvatarUrl);
      profileAvatarUrl = data.signedUrl;
      renderProfileAvatar(profileAvatarUrl);
    };
    const uploadProfileAvatar = async (user, file) => {
      const path = profileAvatarPath(user);
      const { error } = await supabaseClient.storage
        .from(profilePhotoBucket)
        .upload(path, file, {
          cacheControl: "3600",
          contentType: file.type,
          upsert: true,
        });
      if (error) throw error;
      return path;
    };
    const queueProfilePhotoSync = operation => {
      const task = profilePhotoSyncQueue.then(operation);
      profilePhotoSyncQueue = task.then(() => undefined, () => undefined);
      return task;
    };
    const loadProfile = async user => {
      const { data, error } = await supabaseClient
        .from("user_profiles")
        .select("email, first_name, last_name, phone, bust, waist, hip, color_palette, remember_measurements, remember_photo, photo_path, avatar_path")
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) {
        showAccountStatus(`No se pudo recuperar el perfil: ${error.message}`);
        console.error("No se pudo recuperar el perfil de Supabase.", error);
        throw error;
      }
      if (!data) {
        profileAvatarPathValue = null;
        await loadProfileAvatar(user, null);
        profileFirstNameInput.value = user.user_metadata?.first_name || "";
        profileLastNameInput.value = user.user_metadata?.last_name || "";
        savedProfileFirstName = profileFirstNameInput.value;
        savedProfileLastName = profileLastNameInput.value;
        profileName.textContent = profileFirstNameInput.value || user.email || "Mi Perfil";
        updateProfileGreeting(savedProfileFirstName, savedProfileLastName);
        profileEmailInput.value = user.email || "";
        showAccountStatus("Sesión iniciada. Completa tus datos de cuenta para guardarlos.");
        return false;
      }
      profileEmailInput.value = data.email || user.email || "";
      profileFirstNameInput.value = data.first_name || user.user_metadata?.first_name || "";
      profileLastNameInput.value = data.last_name || user.user_metadata?.last_name || "";
      savedProfileFirstName = profileFirstNameInput.value;
      savedProfileLastName = profileLastNameInput.value;
      profileName.textContent = profileFirstNameInput.value
        || data.email || user.email || "Mi Perfil";
      updateProfileGreeting(savedProfileFirstName, savedProfileLastName);
      profilePhoneInput.value = (data.phone || "")
        .replace(/^\+56 9 /, "").replace(" ", "");
      profileAvatarPathValue = data.avatar_path || null;
      await loadProfileAvatar(user, profileAvatarPathValue);
      const profileMeasures = {
        bust: data.bust,
        waist: data.waist,
        hip: data.hip,
      };
      [[profileBustInput, "bust"], [profileWaistInput, "waist"], [profileHipInput, "hip"]]
        .forEach(([input, name]) => {
          if (input) input.value = typeof profileMeasures[name] === "number"
            ? String(profileMeasures[name])
            : "";
        });
      rememberCheckbox.checked = (
        data.remember_measurements === true || data.remember_photo === true
      );
      if (rememberCheckbox.checked) {
        measurementFields.forEach(field => {
          const value = typeof profileMeasures[field.name] === "number"
            ? profileMeasures[field.name]
            : data[field.name];
          if (typeof value === "number") {
            field.value = String(value);
            field.dispatchEvent(new Event("input", { bubbles: true }));
          }
        });
        try {
          saveMeasurements();
        } catch (storageError) {
          console.error("No se pudo conservar el perfil en este navegador.", storageError);
        }
      }
      if (Array.isArray(data.color_palette)) {
        window.dispatchEvent(new CustomEvent("matices:restore-palette", {
          detail: { palette: rememberCheckbox.checked ? data.color_palette : [] },
        }));
      }
      rememberPhotoInput.checked = data.remember_photo === true;
      rememberedPhotoPath = data.photo_path;
      if (rememberPhotoInput.checked && rememberedPhotoPath) {
        if (rememberedPhotoPath !== profilePhotoPath(user)) {
          throw new Error("La ruta de la foto del perfil no es válida.");
        }
        const { data: photo, error: photoError } = await supabaseClient.storage
          .from(profilePhotoBucket)
          .download(rememberedPhotoPath);
        if (photoError) throw photoError;
        window.dispatchEvent(new CustomEvent("matices:restore-photo", {
          detail: {
            file: new File([photo], "foto-recordada", {
              type: photo.type || "image/jpeg",
              lastModified: Date.now(),
            }),
          },
        }));
      }
      showAccountStatus("Perfil recuperado de tu cuenta de Supabase.");
      return true;
    };
    const handleAuthSession = async session => {
      const user = session?.user ?? null;
      const userId = user?.id ?? null;
      if (userId === activeUserId) return;
      const previousUserId = activeUserId;
      activeUserId = userId;
      profileLoadedUserId = null;
      signedInUser = user;
      setAuthControls(user);
      if (!user) {
        if (previousUserId) {
          pendingPhotoRemember = false;
          window.dispatchEvent(new CustomEvent("matices:clear-account-data"));
        }
        savedProfileFirstName = "";
        savedProfileLastName = "";
        rememberedPhotoPath = null;
        rememberCheckbox.checked = false;
        measurementFields.forEach(field => { field.value = ""; });
        localStorage.removeItem(rememberedEnabledKey);
        localStorage.removeItem(rememberedValuesKey);
        showAccountStatus("Inicia sesión para sincronizar de forma privada tus medidas y paleta.");
        finishAuthStateInitialization(false);
        redirectUnauthenticatedView();
        return;
      }
      showAccountStatus(`Sesión iniciada como ${user.email || "usuario"}. Recuperando perfil…`);
      const hasProfile = await loadProfile(user);
      profileLoadedUserId = user.id;
      if (pendingPhotoRemember) {
        rememberCheckbox.checked = true;
        rememberPhotoInput.checked = true;
        if (latestSelectedPhoto) {
          rememberedPhotoPath = await uploadProfilePhoto(user, latestSelectedPhoto);
        }
        await saveProfile();
        pendingPhotoRemember = false;
      } else if (!hasProfile && (rememberCheckbox?.checked || rememberPhotoInput?.checked)) {
        if (rememberPhotoInput.checked && latestSelectedPhoto) {
          rememberedPhotoPath = await uploadProfilePhoto(user, latestSelectedPhoto);
        }
        await saveProfile();
      }
      finishAuthStateInitialization(true);
      if (new URLSearchParams(window.location.search).get("view") === "account") {
        window.location.assign(`/?view=${authReturnView}`);
      } else if (returnToHomeAfterSignIn) {
        returnToHomeAfterSignIn = false;
        window.location.assign("/?view=storefront");
      }
    };
    const credentials = () => {
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      if (!emailInput.checkValidity() || !passwordInput.checkValidity() || !email || !password) {
        showAccountStatus("Ingresa un correo válido y una contraseña de al menos 8 caracteres.");
        return null;
      }
      const firstName = signUpNameInput?.value.trim() || "";
      const lastName = signUpLastNameInput?.value.trim() || "";
      if (authMode === "sign-up" && (!firstName || !lastName)) {
        showAccountStatus("Ingresa tu nombre y apellido para crear la cuenta.");
        (firstName ? signUpLastNameInput : signUpNameInput).focus();
        return null;
      }
      if (authMode === "sign-up" && password !== confirmPasswordInput.value) {
        showAccountStatus("Las contraseñas no coinciden.");
        confirmPasswordInput.focus();
        return null;
      }
      return { email, password, firstName, lastName };
    };
    authModeButtons.forEach(button => {
      button.addEventListener("click", () => {
        setAuthMode(button.dataset.authMode);
        showAccountStatus("");
      });
    });
    document.querySelectorAll("[data-open-account]").forEach(link => {
      link.addEventListener("click", event => {
        if (link.dataset.openAccount === "sign-in") {
          authReturnView = "storefront";
          returnToHomeAfterSignIn = true;
        }
        const homePanel = document.querySelector('[data-page-panel="home"]');
        if (homePanel?.hidden) return;
        event.preventDefault();
        setAuthMode(link.dataset.openAccount);
        showAccountStatus("");
        window.dispatchEvent(new CustomEvent("calce:open-account"));
        emailInput.focus({ preventScroll: true });
      });
    });
    [emailInput, passwordInput].forEach(input => {
      input.addEventListener("keydown", event => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        (authMode === "sign-up" ? signUpButton : signInButton).click();
      });
    });

    signInButton.addEventListener("click", async () => {
      const values = credentials();
      if (!values || !supabaseClient) return;
      signInButton.disabled = true;
      try {
        const { error } = await supabaseClient.auth.signInWithPassword({
          email: values.email,
          password: values.password,
        });
        if (error) {
          showAccountStatus(`No se pudo iniciar sesión: ${error.message}`);
          console.error("No se pudo iniciar sesión en Supabase.", error);
        }
      } catch (error) {
        showAccountStatus(`No se pudo iniciar sesión: ${error.message}`);
        console.error("No se pudo iniciar sesión en Supabase.", error);
      } finally {
        signInButton.disabled = false;
      }
    });
    signUpButton.addEventListener("click", async () => {
      const values = credentials();
      if (!values || !supabaseClient) return;
      signUpButton.disabled = true;
      try {
        const { data, error } = await supabaseClient.auth.signUp({
          email: values.email,
          password: values.password,
          options: {
            data: {
              first_name: values.firstName,
              last_name: values.lastName,
            },
            emailRedirectTo: new URL(
              `/?view=account&auth_mode=sign-in&return_view=${authReturnView}`,
              window.location.origin,
            ).toString(),
          },
        });
        if (error) {
          showAccountStatus(`No se pudo crear la cuenta: ${error.message}`);
          console.error("No se pudo crear la cuenta de Supabase.", error);
        } else if (!data.session) {
          showAccountStatus("Cuenta creada. Revisa tu correo para confirmar el registro.");
        } else {
          showAccountStatus("Cuenta creada. Recuperando tu perfil…");
        }
      } catch (error) {
        showAccountStatus(`No se pudo crear la cuenta: ${error.message}`);
        console.error("No se pudo crear la cuenta de Supabase.", error);
      } finally {
        signUpButton.disabled = false;
      }
    });
    signOutButton.addEventListener("click", async () => {
      if (!supabaseClient || !signedInUser) return;
      signOutButton.disabled = true;
      window.clearTimeout(cloudSaveTimer);
      try {
        const { error } = await supabaseClient.auth.signOut();
        if (error) {
          showAccountStatus(`No se pudo cerrar sesión: ${error.message}`);
          console.error("No se pudo cerrar la sesión de Supabase.", error);
        } else {
          await handleAuthSession(null);
          profileMenu.open = false;
          passwordInput.value = "";
          confirmPasswordInput.value = "";
          showAccountStatus("Sesión cerrada.");
        }
      } catch (error) {
        showAccountStatus(`No se pudo cerrar sesión: ${error.message}`);
        console.error("No se pudo cerrar la sesión de Supabase.", error);
      } finally {
        signOutButton.disabled = false;
      }
    });
    rememberCheckbox?.addEventListener("change", scheduleProfileSave);
    const formatProfilePhone = () => {
      if (!profilePhoneInput) return;
      const digits = profilePhoneInput.value.replace(/\D/g, "").slice(0, 8);
      profilePhoneInput.value = digits.length > 4
        ? `${digits.slice(0, 4)} ${digits.slice(4)}`
        : digits;
    };
    profilePhoneInput?.addEventListener("input", formatProfilePhone);
    saveProfileDataButton?.addEventListener("click", async () => {
      if (!signedInUser || !supabaseClient) return;
      const firstName = profileFirstNameInput.value.trim();
      const lastName = profileLastNameInput.value.trim();
      if (!firstName || !lastName) {
        profileDataStatus.textContent = "El nombre y el apellido son obligatorios.";
        return;
      }
      const phoneDigits = profilePhoneInput.value.replace(/\D/g, "");
      if (phoneDigits && phoneDigits.length !== 8) {
        profileDataStatus.textContent = "Ingresa los 8 dígitos de tu teléfono chileno.";
        profilePhoneInput.focus();
        return;
      }
      saveProfileDataButton.disabled = true;
      profileDataStatus.textContent = "Guardando datos de tu cuenta…";
      try {
        measurementFields.forEach(field => {
          const profileInput = {
            bust: profileBustInput,
            waist: profileWaistInput,
            hip: profileHipInput,
          }[field.name];
          field.value = profileInput?.value || "";
        });
        rememberCheckbox.checked = true;
        const saved = await saveProfile(true, true);
        if (saved) {
          profileDataStatus.textContent = "Datos guardados. Las medidas se sincronizaron con Tu Calce.";
          measurementFields.forEach(field => {
            field.dispatchEvent(new Event("input", { bubbles: true }));
          });
        }
      } catch (error) {
        profileDataStatus.textContent = `No se pudieron guardar los datos: ${error.message}`;
        console.error("No se pudieron guardar los datos de cuenta.", error);
      } finally {
        saveProfileDataButton.disabled = false;
      }
    });
    profileAvatarInput?.addEventListener("change", async () => {
      const file = profileAvatarInput.files?.[0];
      if (!file || !signedInUser || !supabaseClient) return;
      const allowedTypes = new Set([
        "image/jpeg", "image/png", "image/webp", "image/gif", "image/avif",
      ]);
      if (!allowedTypes.has(file.type) || file.size > 10 * 1024 * 1024) {
        profileDataStatus.textContent = "Elige una imagen compatible de hasta 10 MB.";
        profileAvatarInput.value = "";
        return;
      }
      try {
        profileAvatarPathValue = await uploadProfileAvatar(signedInUser, file);
        await saveProfile();
        await loadProfileAvatar(signedInUser, profileAvatarPathValue);
        profileDataStatus.textContent = "Foto de perfil actualizada.";
      } catch (error) {
        profileDataStatus.textContent = `No se pudo actualizar la foto: ${error.message}`;
        console.error("No se pudo guardar la foto de perfil.", error);
      }
    });
    removeProfileAvatarButton?.addEventListener("click", async () => {
      const user = signedInUser;
      const path = profileAvatarPathValue;
      if (!user || !supabaseClient || !path) return;
      if (path !== profileAvatarPath(user)) {
        profileDataStatus.textContent = "No se pudo quitar la foto de perfil.";
        console.error("La ruta de la foto de perfil no es válida.");
        return;
      }
      if (!window.confirm("¿Quieres quitar tu foto de perfil?")) return;

      removeProfileAvatarButton.disabled = true;
      profileDataStatus.textContent = "Quitando foto de perfil…";
      try {
        const { error } = await supabaseClient
          .from("user_profiles")
          .update({ avatar_path: null })
          .eq("user_id", user.id);
        if (error) throw error;
      } catch (error) {
        profileDataStatus.textContent = `No se pudo quitar la foto: ${error.message}`;
        console.error("No se pudo quitar la foto del perfil.", error);
        removeProfileAvatarButton.disabled = false;
        return;
      }

      profileAvatarPathValue = null;
      await loadProfileAvatar(user, null);
      try {
        const { error } = await supabaseClient.storage
          .from(profilePhotoBucket)
          .remove([path]);
        if (error) throw error;
        profileDataStatus.textContent = "Foto de perfil eliminada.";
      } catch (error) {
        profileDataStatus.textContent = (
          "La foto se quitó del perfil, pero no se pudo eliminar su archivo "
          + `del almacenamiento: ${error.message}`
        );
        console.error("No se pudo eliminar la foto del perfil en Supabase Storage.", error);
      } finally {
        removeProfileAvatarButton.disabled = false;
      }
    });
    window.addEventListener("matices:photo-selected", event => {
      latestSelectedPhoto = event.detail?.file;
      if (rememberPhotoInput.checked && !signedInUser) {
        pendingPhotoRemember = true;
      }
      if (
        !latestSelectedPhoto
        || !supabaseClient
        || !signedInUser
        || profileLoadedUserId !== signedInUser.id
        || !rememberPhotoInput.checked
      ) return;
      queueProfilePhotoSync(async () => {
        const user = signedInUser;
        if (!user || profileLoadedUserId !== user.id || !rememberPhotoInput.checked) return false;
        rememberedPhotoPath = await uploadProfilePhoto(user, latestSelectedPhoto);
        await saveProfile();
        return true;
      })
        .then(saved => {
          if (saved) showPhotoRememberStatus("Foto guardada de forma privada en tu cuenta.");
        })
        .catch(error => {
          showPhotoRememberStatus(`No se pudo guardar la foto en tu cuenta: ${error.message}`);
          console.error("No se pudo guardar la foto del perfil en Supabase.", error);
        });
    });
    window.addEventListener("matices:photo-remember-changed", async event => {
      const { enabled, file } = event.detail || {};
      if (enabled) {
        rememberCheckbox.checked = true;
        try {
          saveMeasurements();
        } catch (error) {
          console.error("No se pudieron recordar las medidas en este navegador.", error);
        }
        if (file) latestSelectedPhoto = file;
      }
      if (!signedInUser || profileLoadedUserId !== signedInUser.id) {
        pendingPhotoRemember = enabled === true;
        return;
      }
      if (
        !supabaseClient
        || !signedInUser
      ) return;
      window.clearTimeout(cloudSaveTimer);
      try {
        await queueProfilePhotoSync(async () => {
          const user = signedInUser;
          if (!user || profileLoadedUserId !== user.id) return;
          if (enabled && file) {
            latestSelectedPhoto = file;
            rememberedPhotoPath = await uploadProfilePhoto(user, file);
          } else if (!enabled) {
            await deleteProfilePhoto(user);
            rememberedPhotoPath = null;
          }
          await saveProfile();
        });
        showPhotoRememberStatus(enabled
          ? "La preferencia de foto se sincronizó con tu cuenta."
          : "La foto se eliminó de tu cuenta.");
      } catch (error) {
        showPhotoRememberStatus(`No se pudo sincronizar la foto con tu cuenta: ${error.message}`);
        console.error("No se pudo sincronizar la preferencia de foto.", error);
      }
    });
    window.addEventListener("matices:photo-removed", async () => {
      latestSelectedPhoto = null;
      if (
        !supabaseClient
        || !signedInUser
        || profileLoadedUserId !== signedInUser.id
      ) return;
      window.clearTimeout(cloudSaveTimer);
      try {
        await queueProfilePhotoSync(async () => {
          const user = signedInUser;
          if (!user || profileLoadedUserId !== user.id) return;
          await deleteProfilePhoto(user);
          rememberedPhotoPath = null;
          await saveProfile();
        });
        showPhotoRememberStatus("La foto se eliminó del navegador y de tu cuenta.");
      } catch (error) {
        showPhotoRememberStatus(`No se pudo eliminar la foto de tu cuenta: ${error.message}`);
        console.error("No se pudo eliminar la foto del perfil en Supabase.", error);
      }
    });
    measurementFields.forEach(field => field.addEventListener("input", scheduleProfileSave));
    window.addEventListener("matices:palette-updated", scheduleProfileSave);

    if (!supabaseUrl || !supabaseKey) {
      signInButton.disabled = true;
      signUpButton.disabled = true;
      signOutButton.hidden = true;
      showAccountStatus("Falta configurar SUPABASE_PUBLISHABLE_KEY en el entorno del servidor.");
      finishAuthStateInitialization(false);
      redirectUnauthenticatedView();
    } else {
      signInButton.disabled = true;
      signUpButton.disabled = true;
      showAccountStatus("Conectando con el servicio de cuentas…");
      import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm")
        .then(({ createClient }) => {
          supabaseClient = createClient(supabaseUrl, supabaseKey, {
            auth: { storage: authStorage },
          });
          window.calceSupabaseClient = supabaseClient;
          window.dispatchEvent(new CustomEvent("calce:supabase-ready", {
            detail: { client: supabaseClient },
          }));
          supabaseClient.auth.onAuthStateChange((_event, session) => {
            window.setTimeout(() => {
              handleAuthSession(session).catch(error => {
                showAccountStatus(`No se pudo cargar el perfil: ${error.message}`);
                finishAuthStateInitialization(Boolean(session?.user));
                console.error("No se pudo procesar la sesión de Supabase.", error);
              });
            }, 0);
          });
          return supabaseClient.auth.getSession();
        })
        .then(({ data, error }) => {
          if (error) throw error;
          signInButton.disabled = false;
          signUpButton.disabled = false;
          return handleAuthSession(data.session);
        })
        .catch(error => {
          signInButton.disabled = true;
          signUpButton.disabled = true;
          showAccountStatus(`No se pudo conectar con Supabase: ${error.message}`);
          finishAuthStateInitialization(false);
          redirectUnauthenticatedView();
          console.error("No se pudo inicializar Supabase.", error);
        });
    }
    setAuthMode(authMode);
  }
});
syncCatalogLinkMeasurements();

document.querySelectorAll("[data-carousel]").forEach(carousel => {
  const cards = Array.from(carousel.querySelectorAll("[data-carousel-card]"));
  const previousButton = carousel.querySelector("[data-previous]");
  const nextButton = carousel.querySelector("[data-next]");
  const recommendedButton = carousel.querySelector("[data-recommended]");
  const position = carousel.querySelector("[data-carousel-position]");
  let currentIndex = 0;

  if (!cards.length || !previousButton || !nextButton || !position || !recommendedButton) {
    return;
  }

  const showCard = index => {
    currentIndex = Math.max(0, Math.min(index, cards.length - 1));
    cards.forEach((card, cardIndex) => {
      const isVisible = cardIndex === currentIndex;
      card.hidden = !isVisible;
      card.setAttribute("aria-hidden", String(!isVisible));
    });
    previousButton.disabled = currentIndex === 0;
    nextButton.disabled = currentIndex === cards.length - 1;
    recommendedButton.classList.toggle("active", currentIndex === 0);
    recommendedButton.setAttribute("aria-pressed", String(currentIndex === 0));
    position.textContent = currentIndex === 0
      ? `Recomendado · 1 de ${cards.length}`
      : `Opción ${currentIndex + 1} de ${cards.length}`;
  };

  previousButton.addEventListener("click", () => showCard(currentIndex - 1));
  nextButton.addEventListener("click", () => showCard(currentIndex + 1));
  recommendedButton.addEventListener("click", () => showCard(0));
  showCard(0);
});

document.querySelectorAll("[data-garment-catalog]").forEach(catalog => {
  const sortSelect = catalog.querySelector("[data-catalog-sort]");
  const itemsContainer = catalog.querySelector("[data-catalog-items]");
  const searchForm = catalog.querySelector("[data-catalog-search-form]");
  const searchInput = searchForm?.querySelector("[data-catalog-search]");
  const typeFilter = catalog.querySelector("[data-catalog-type-filter]");
  const sizeFilter = catalog.querySelector("[data-catalog-size-filter]");
  const brandFilter = catalog.querySelector("[data-catalog-brand-filter]");
  const minPriceFilter = catalog.querySelector("[data-catalog-min-price]");
  const maxPriceFilter = catalog.querySelector("[data-catalog-max-price]");
  const resultCount = catalog.querySelector("[data-catalog-result-count]");
  const heading = catalog.querySelector("[data-catalog-heading]");
  const filtersDialog = catalog.querySelector("[data-catalog-filters-dialog]");
  const openFiltersButton = catalog.querySelector("[data-catalog-open-filters]");
  const closeFiltersButton = catalog.querySelector("[data-catalog-close-filters]");
  const clearFiltersButton = catalog.querySelector("[data-catalog-clear-filters]");
  const applyFiltersButton = catalog.querySelector("[data-catalog-apply-filters]");
  const filterCount = catalog.querySelector("[data-catalog-filter-count]");
  const viewCount = catalog.querySelector(".catalog-view-count");
  const viewButtons = catalog.querySelectorAll("[data-catalog-view]");
  const selectionBar = catalog.querySelector("[data-catalog-selection-bar]");
  const selectionStatus = catalog.querySelector("[data-catalog-selection-status]");
  const tryOnButton = catalog.querySelector("[data-catalog-try-on]");
  const parisSizeDialog = catalog.querySelector("[data-catalog-paris-size-dialog]");
  const parisSizeStatus = catalog.querySelector("[data-catalog-paris-size-status]");
  const parisSizeSelectField = catalog.querySelector(
    "[data-catalog-paris-size-select-field]",
  );
  const parisSizeSelect = catalog.querySelector("[data-catalog-paris-size-select]");
  const parisSizeTextField = catalog.querySelector(
    "[data-catalog-paris-size-text-field]",
  );
  const parisSizeTextInput = catalog.querySelector("[data-catalog-paris-size-text]");
  const parisSizeConfirmButton = catalog.querySelector(
    "[data-catalog-paris-size-confirm]",
  );
  const parisSizeCloseButton = catalog.querySelector("[data-catalog-paris-size-close]");
  const parisSizeCancelButton = catalog.querySelector(
    "[data-catalog-paris-size-cancel]",
  );
  const pagination = catalog.querySelector("[data-catalog-pagination]");
  const previousPageButton = catalog.querySelector("[data-catalog-previous]");
  const nextPageButton = catalog.querySelector("[data-catalog-next]");
  const pageLabel = catalog.querySelector("[data-catalog-page]");
  const catalogPagePanel = catalog.closest('[data-page-panel="catalog"]');
  const catalogViewActive = Boolean(catalogPagePanel && !catalogPagePanel.hidden);
  if (searchForm && catalogViewActive) {
    searchForm.classList.add("catalog-search-form--catalog");
    catalog.querySelector(".catalog-main")?.prepend(searchForm);
  }

  if (
    !sortSelect || !itemsContainer || !searchInput ||
    !searchForm || !typeFilter || !sizeFilter || !brandFilter ||
    !minPriceFilter || !maxPriceFilter || !resultCount ||
    !selectionStatus || !tryOnButton ||
    !pagination || !previousPageButton || !nextPageButton || !pageLabel
  ) {
    return;
  }

  let currentPage = Number(catalog.dataset.catalogPageIndex) || 0;
  const selectedCatalogGarments = new Map(
    readSelectedCatalogGarments().map(product => [product.product_url, product]),
  );
  let requestNumber = 0;
  let activeController;
  let searchTimer;
  let pendingParisSizeSelection = null;

  const updateSelection = () => {
    const count = selectedCatalogGarments.size;
    if (selectionBar) selectionBar.hidden = count === 0;
    selectionStatus.textContent = count
      ? `${count} ${count === 1 ? "prenda seleccionada" : "prendas seleccionadas"} para el Probador`
      : "Ninguna prenda seleccionada";
    tryOnButton.disabled = count === 0;
    tryOnButton.textContent = count ? "Probar" : "Selecciona prendas para probarte";
  };

  const updateFilterSummary = () => {
    const activeFilters = [
      typeFilter,
      sizeFilter,
      brandFilter,
      minPriceFilter,
      maxPriceFilter,
    ].filter(filter => filter.value.trim()).length;
    if (filterCount) filterCount.textContent = String(activeFilters);
  };

  const updateHeading = () => {
    if (!heading) return;
    const searchTerm = searchInput.value.trim();
    heading.textContent = searchTerm
      ? `Tus resultados de búsqueda para ${searchTerm}`
      : "Catálogo completo de prendas";
  };

  const updateResultTotal = total => {
    if (applyFiltersButton) {
      applyFiltersButton.dataset.catalogTotal = String(total);
      applyFiltersButton.textContent = `Mostrar ${total} productos`;
    }
    if (viewCount) viewCount.textContent = `${total} prendas`;
  };

  const setCatalogView = view => {
    itemsContainer.dataset.view = view;
    viewButtons.forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.catalogView === view));
    });
  };

  const persistCatalogSelection = (productUrl, previousProduct) => {
    try {
      sessionStorage.setItem(
        catalogSelectionStorageKey,
        JSON.stringify(Array.from(selectedCatalogGarments.values())),
      );
      return true;
    } catch (error) {
      if (previousProduct) {
        selectedCatalogGarments.set(productUrl, previousProduct);
      } else {
        selectedCatalogGarments.delete(productUrl);
      }
      resultCount.textContent = "No se pudo guardar la selección para el Probador.";
      console.error("No se pudo guardar la selección del catálogo.", error);
      return false;
    }
  };

  const selectedParisSize = () => {
    if (!parisSizeSelectField?.hidden) {
      const selectedOption = parisSizeSelect?.selectedOptions[0];
      return selectedOption && !selectedOption.disabled
        ? selectedOption.value.trim()
        : "";
    }
    if (!parisSizeTextField?.hidden) return parisSizeTextInput?.value.trim() || "";
    return "";
  };
  const updateParisSizeConfirmButton = () => {
    if (parisSizeConfirmButton) {
      parisSizeConfirmButton.disabled = !selectedParisSize();
    }
  };
  const openParisSizeDialog = (checkbox, sizeInput, confirmSelection) => {
    if (!parisSizeDialog || !parisSizeSelect || !parisSizeTextInput || !sizeInput) {
      resultCount.textContent = "No se pudo abrir la selección de talla para París.";
      return false;
    }
    const availableOptions = sizeInput.tagName === "SELECT"
      ? Array.from(sizeInput.options).filter(option => option.value.trim())
      : [];
    const hasAvailableSizes = availableOptions.length > 0;
    const hasInStockSizes = availableOptions.some(option => !option.disabled);
    if (parisSizeSelectField) parisSizeSelectField.hidden = !hasAvailableSizes;
    if (parisSizeTextField) parisSizeTextField.hidden = hasAvailableSizes;
    parisSizeSelect.replaceChildren(
      ...(hasAvailableSizes
        ? Array.from(sizeInput.options, option => option.cloneNode(true))
        : []),
    );
    parisSizeSelect.value = hasAvailableSizes
      ? availableOptions.find(
        option => option.value === sizeInput.value && !option.disabled,
      )?.value || ""
      : "";
    parisSizeTextInput.value = hasAvailableSizes ? "" : sizeInput.value;
    if (parisSizeStatus) {
      parisSizeStatus.textContent = !hasAvailableSizes
        ? "No hay tallas predefinidas; escribe la talla que quieres probarte."
        : hasInStockSizes
          ? ""
          : "No hay tallas con stock disponibles.";
    }
    pendingParisSizeSelection = { checkbox, confirmSelection };
    updateParisSizeConfirmButton();
    parisSizeDialog.showModal();
    (hasAvailableSizes ? parisSizeSelect : parisSizeTextInput).focus();
    return true;
  };
  parisSizeSelect?.addEventListener("change", () => {
    if (parisSizeStatus) parisSizeStatus.textContent = "";
    updateParisSizeConfirmButton();
  });
  parisSizeTextInput?.addEventListener("input", updateParisSizeConfirmButton);
  parisSizeConfirmButton?.addEventListener("click", () => {
    const selectedSize = selectedParisSize();
    if (!pendingParisSizeSelection) return;
    if (!selectedSize) {
      if (parisSizeStatus) parisSizeStatus.textContent = "Selecciona o escribe una talla.";
      return;
    }
    const pendingSelection = pendingParisSizeSelection;
    pendingParisSizeSelection = null;
    pendingSelection.confirmSelection(selectedSize);
    parisSizeDialog?.close();
  });
  parisSizeCloseButton?.addEventListener("click", () => parisSizeDialog?.close());
  parisSizeCancelButton?.addEventListener("click", () => parisSizeDialog?.close());
  parisSizeDialog?.addEventListener("close", () => {
    if (pendingParisSizeSelection) {
      pendingParisSizeSelection.checkbox.checked = false;
      pendingParisSizeSelection = null;
    }
    if (parisSizeSelectField) parisSizeSelectField.hidden = true;
    if (parisSizeTextField) parisSizeTextField.hidden = true;
    if (parisSizeSelect) parisSizeSelect.replaceChildren();
    if (parisSizeTextInput) parisSizeTextInput.value = "";
    if (parisSizeStatus) parisSizeStatus.textContent = "";
    if (parisSizeConfirmButton) parisSizeConfirmButton.disabled = true;
  });
  parisSizeDialog?.addEventListener("click", event => {
    if (event.target === parisSizeDialog) parisSizeDialog.close();
  });

  const bindCard = item => {
    const checkbox = item.querySelector("[data-catalog-select]");
    if (checkbox) {
      const productUrl = item.querySelector(".catalog-buy-link")?.href;
      const productName = item.querySelector(".catalog-item-info h3")?.textContent?.trim();
      const quantityInput = item.querySelector("[data-catalog-quantity]");
      const sizeInput = item.querySelector("[data-catalog-size-choice]");
      if (item.dataset.catalogStore === "Paris") updateParisSizeSelect(sizeInput);
      const persistSelectedProduct = (selectedUrl, previousProduct, selectedSize) => {
        const quantity = quantityInput ? Number(quantityInput.value) : 1;
        selectedCatalogGarments.set(selectedUrl, {
          product_url: selectedUrl,
          image_url: item.querySelector(".catalog-image")?.src || "",
          store: item.dataset.catalogStore || "",
          brand: item.dataset.catalogBrand || "",
          title: productName,
          size: item.dataset.catalogSize || "",
          selected_size: selectedSize,
          quantity: Number.isSafeInteger(quantity) && quantity > 0
            ? quantity
            : 1,
          price_clp: Number(item.dataset.catalogPrice) || null,
          category: item.dataset.catalogTryOnCategory || "",
        });
        if (!persistCatalogSelection(selectedUrl, previousProduct)) {
          checkbox.checked = Boolean(previousProduct);
          updateSelection();
          return false;
        }
        checkbox.checked = true;
        checkbox.setAttribute("aria-label", `Quitar ${productName} del Probador`);
        updateSelection();
        return true;
      };
      const savedProduct = productUrl
        ? selectedCatalogGarments.get(productUrl)
        : null;
      checkbox.checked = Boolean(savedProduct);
      if (savedProduct) {
        if (quantityInput) {
          quantityInput.value = String(savedProduct.quantity || 1);
        }
        if (sizeInput) sizeInput.value = savedProduct.selected_size || "";
      }
      if (productName) {
        checkbox.setAttribute(
          "aria-label",
          checkbox.checked
            ? `Quitar ${productName} del Probador`
            : `Seleccionar ${productName} para el Probador`,
        );
      }
      checkbox.addEventListener("change", () => {
        const productLink = item.querySelector(".catalog-buy-link");
        if (!productLink || !productName) {
          checkbox.checked = false;
          resultCount.textContent = "No se pudo identificar la prenda seleccionada.";
          return;
        }

        const selectedUrl = productLink.href;
        const previousProduct = selectedCatalogGarments.get(selectedUrl);
        if (checkbox.checked) {
          if (item.dataset.catalogStore === "Paris") {
            checkbox.checked = false;
            openParisSizeDialog(
              checkbox,
              sizeInput,
              selectedSize => {
                if (sizeInput) sizeInput.value = selectedSize;
                persistSelectedProduct(selectedUrl, previousProduct, selectedSize);
              },
            );
            return;
          }
          persistSelectedProduct(selectedUrl, previousProduct, sizeInput?.value.trim() || "");
          return;
        }
        selectedCatalogGarments.delete(selectedUrl);
        if (!persistCatalogSelection(selectedUrl, previousProduct)) {
          checkbox.checked = Boolean(previousProduct);
          updateSelection();
          return;
        }
        checkbox.setAttribute(
          "aria-label",
          checkbox.checked
            ? `Quitar ${productName} del Probador`
            : `Seleccionar ${productName} para el Probador`,
        );
        updateSelection();
      });

      const persistPurchaseDetails = () => {
        if (!checkbox.checked || !productUrl) return;
        const previousProduct = selectedCatalogGarments.get(productUrl);
        if (!previousProduct) return;
        const quantity = quantityInput ? Number(quantityInput.value) : 1;
        if (!Number.isSafeInteger(quantity) || quantity < 1) {
          resultCount.textContent = "Indica una cantidad válida (mínimo 1).";
          if (quantityInput) quantityInput.value = String(previousProduct.quantity || 1);
          return;
        }
        selectedCatalogGarments.set(productUrl, {
          ...previousProduct,
          quantity,
          selected_size: sizeInput?.value.trim() || "",
        });
        if (!persistCatalogSelection(productUrl, previousProduct)) {
          if (quantityInput) {
            quantityInput.value = String(previousProduct.quantity || 1);
          }
          if (sizeInput) sizeInput.value = previousProduct.selected_size || "";
        }
      };
      quantityInput?.addEventListener("change", persistPurchaseDetails);
      sizeInput?.addEventListener("change", persistPurchaseDetails);
    }

    const image = item.querySelector(".catalog-image");
    if (!image) return;
    image.addEventListener(
      "error",
      () => {
        item.remove();
      },
      { once: true },
    );
    if (image.complete && image.naturalWidth === 0) image.dispatchEvent(new Event("error"));
  };
  catalog.querySelectorAll("[data-catalog-card]").forEach(bindCard);
  updateSelection();

  const loadPage = async page => {
    const requestId = ++requestNumber;
    activeController?.abort();
    activeController = new AbortController();
    const params = new URLSearchParams(window.location.search);
    params.set("search", searchInput.value.trim());
    params.set("type", typeFilter.value);
    params.set("size", sizeFilter.value);
    params.set("brand", brandFilter.value);
    params.set("min_price", minPriceFilter.value);
    params.set("max_price", maxPriceFilter.value);
    params.set("sort", sortSelect.value);
    params.set("page", String(page));

    try {
      const response = await fetch(`/api/catalog?${params}`, {
        signal: activeController.signal,
      });
      if (!response.ok) {
        throw new Error(`El servidor respondió HTTP ${response.status}.`);
      }
      const data = await readJsonResponse(response, "Catálogo");
      if (requestId !== requestNumber) return;
      const template = document.createElement("template");
      template.innerHTML = data.cards;
      itemsContainer.replaceChildren(template.content);
      currentPage = data.page;
      catalog.dataset.catalogPageIndex = String(currentPage);
      resultCount.textContent = data.result_text;
      updateResultTotal(data.total);
      updateFilterSummary();
      updateHeading();
      pageLabel.textContent = data.page_text;
      previousPageButton.disabled = currentPage === 0;
      nextPageButton.disabled = currentPage >= data.pages - 1;
      pagination.hidden = data.pages <= 1;
      itemsContainer.querySelectorAll("[data-catalog-card]").forEach(bindCard);
      window.dispatchEvent(new Event("calce:catalog-cards-rendered"));
      updateSelection();
    } catch (error) {
      if (error.name === "AbortError") return;
      resultCount.textContent = "No se pudo cargar el catálogo. Inténtalo nuevamente.";
      console.error("No se pudo cargar la página del catálogo.", error);
    }
  };

  sortSelect.addEventListener("change", () => loadPage(0));
  [typeFilter, sizeFilter, brandFilter, minPriceFilter, maxPriceFilter].forEach(filter => {
    filter.addEventListener("change", () => {
      updateFilterSummary();
      loadPage(0);
    });
  });
  openFiltersButton?.addEventListener("click", () => {
    filtersDialog?.showModal();
    openFiltersButton.setAttribute("aria-expanded", "true");
  });
  closeFiltersButton?.addEventListener("click", () => filtersDialog?.close());
  applyFiltersButton?.addEventListener("click", () => filtersDialog?.close());
  clearFiltersButton?.addEventListener("click", () => {
    [typeFilter, sizeFilter, brandFilter, minPriceFilter, maxPriceFilter].forEach(filter => {
      filter.value = "";
    });
    updateFilterSummary();
    loadPage(0);
  });
  filtersDialog?.addEventListener("close", () => {
    openFiltersButton?.setAttribute("aria-expanded", "false");
  });
  filtersDialog?.addEventListener("click", event => {
    if (event.target === filtersDialog) filtersDialog.close();
  });
  viewButtons.forEach(button => {
    button.addEventListener("click", () => setCatalogView(button.dataset.catalogView));
  });
  updateFilterSummary();
  if (applyFiltersButton) {
    updateResultTotal(Number(applyFiltersButton.dataset.catalogTotal) || 0);
  }
  viewButtons.forEach(button => {
    if (button.getAttribute("aria-pressed") === "true") {
      setCatalogView(button.dataset.catalogView);
    }
  });
  searchForm.addEventListener("submit", event => {
    if (!catalogViewActive) return;
    event.preventDefault();
    window.clearTimeout(searchTimer);
    loadPage(0);
  });
  previousPageButton.addEventListener("click", () => {
    loadPage(currentPage - 1);
    catalog.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  nextPageButton.addEventListener("click", () => {
    loadPage(currentPage + 1);
    catalog.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  tryOnButton.addEventListener("click", () => {
    if (!selectedCatalogGarments.size) return;
    window.location.assign(
      document.getElementById("try-on-link")?.href || "/?view=try-on",
    );
  });
  window.addEventListener("calce:catalog-selection-cleared", () => {
    selectedCatalogGarments.clear();
    itemsContainer.querySelectorAll("[data-catalog-select]").forEach(checkbox => {
      checkbox.checked = false;
      const productName = checkbox
        .closest("[data-catalog-card]")
        ?.querySelector(".catalog-item-info h3")
        ?.textContent
        ?.trim();
      if (productName) {
        checkbox.setAttribute(
          "aria-label",
          `Seleccionar ${productName} para el Probador`,
        );
      }
    });
    updateSelection();
  });
  if (catalogViewActive) {
    searchInput.addEventListener("input", () => {
      updateHeading();
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => loadPage(0), 250);
    });
  }
});

(() => {
  const wizard = document.getElementById("style-wizard");
  if (!wizard) return;

  const fileInput = document.getElementById("matices-photo-input");
  const preview = document.getElementById("matices-preview");
  const previewBox = document.getElementById("matices-preview-box");
  const removePhotoButton = wizard.querySelector("[data-photo-remove]");
  const status = document.getElementById("matices-status");
  const nextButton = document.getElementById("matices-next-step");
  const cameraButton = wizard.querySelector("[data-camera-open]");
  const cameraPanel = wizard.querySelector("[data-camera-panel]");
  const cameraVideo = document.getElementById("matices-camera-video");
  const captureButton = wizard.querySelector("[data-camera-capture]");
  const cancelCameraButton = wizard.querySelector("[data-camera-cancel]");
  const rememberBox = document.getElementById("matices-remember");
  const rememberRow = document.getElementById("matices-remember-row");
  const rememberStatus = document.getElementById("matices-remember-status");
  const paletteSummaryStatus = wizard.querySelector("[data-palette-summary-status]");
  const paletteSummaryColors = wizard.querySelector("[data-palette-summary-colors]");
  const sizeSummaryStatus = wizard.querySelector("[data-size-summary-status]");
  const sizeSummarySizes = wizard.querySelector("[data-size-summary-sizes]");
  const sizeSummaryMeasures = wizard.querySelector("[data-size-summary-measures]");
  const progressFill = document.querySelector("[data-wizard-progress-fill]");
  const progressBar = document.querySelector(".wizard-progress-bar");
  const wizardSteps = Array.from(document.querySelectorAll(".wizard-progress-steps span"));
  const panels = Array.from(wizard.querySelectorAll("[data-wizard-panel]"));
  const accountPanel = wizard.querySelector("[data-account-panel]");
  const accountLinks = Array.from(document.querySelectorAll("[data-open-account]"));
  const stepInput = wizard.querySelector('input[name="wizard_step"]');
  const wizardForm = wizard.querySelector("[data-style-wizard-form]");
  const tryOnLink = document.getElementById("try-on-link");
  const tryOnPagePanel = document.getElementById("try-on-panel");
  const tryOnPanel = document.querySelector("[data-virtual-try-on]");
  const tryOnProductSelect = tryOnPanel?.querySelector("[data-vton-product-select]");
  const tryOnProviderSelect = tryOnPanel?.querySelector("[data-vton-provider]");
  const tryOnProviderHelp = tryOnPanel?.querySelector("#vton-provider-help");
  const tryOnGoCartLink = tryOnPanel?.querySelector("[data-vton-open-cart-choice]");
  const tryOnCartChoiceDialog = tryOnPanel?.querySelector(
    "[data-vton-cart-choice-dialog]",
  );
  const tryOnPaymentChoiceDialog = tryOnPanel?.querySelector(
    "[data-vton-payment-choice-dialog]",
  );
  const tryOnPaymentYesButton = tryOnPanel?.querySelector(
    "[data-vton-payment-yes]",
  );
  const tryOnPaymentNoButton = tryOnPanel?.querySelector(
    "[data-vton-payment-no]",
  );
  const tryOnCatalogLink = document.getElementById("catalog-link");
  const tryOnCartChoiceList = tryOnPanel?.querySelector(
    "[data-vton-cart-choice-list]",
  );
  const tryOnCartChoiceEmpty = tryOnPanel?.querySelector(
    "[data-vton-cart-choice-empty]",
  );
  const tryOnCartChoiceStatus = tryOnPanel?.querySelector(
    "[data-vton-cart-choice-status]",
  );
  const tryOnCartChoiceConfirmButton = tryOnPanel?.querySelector(
    "[data-vton-cart-choice-confirm]",
  );
  const tryOnCartChoiceCloseButton = tryOnPanel?.querySelector(
    "[data-vton-cart-choice-close]",
  );
  const tryOnCartTotal = tryOnPanel?.querySelector("[data-vton-cart-total] strong");
  const tryOnGenderField = tryOnPanel?.querySelector("[data-vton-gender-field]");
  const tryOnGenderSelect = tryOnPanel?.querySelector("[data-vton-gender]");
  const tryOnProductList = tryOnPanel?.querySelector("[data-vton-product-list]");
  const tryOnGarmentTooltip = tryOnPanel?.querySelector("[data-vton-garment-tooltip]");
  const tryOnTooltipImage = tryOnPanel?.querySelector("[data-vton-tooltip-image]");
  const tryOnTooltipTitle = tryOnPanel?.querySelector("[data-vton-tooltip-title]");
  const tryOnPersonPreview = tryOnPanel?.querySelector("[data-vton-person-preview]");
  const tryOnPersonEmpty = tryOnPanel?.querySelector("[data-vton-person-empty]");
  const tryOnGenerateButton = tryOnPanel?.querySelector("[data-vton-generate]");
  const tryOnStatus = tryOnPanel?.querySelector("[data-vton-status]");
  const tryOnResult = tryOnPanel?.querySelector("[data-vton-result]");
  const tryOnResultImage = tryOnPanel?.querySelector("[data-vton-result-image]");
  const tryOnResultStatus = tryOnPanel?.querySelector("[data-vton-result-status]");

  const updateTryOnProviderHelp = () => {
    if (!tryOnProviderSelect || !tryOnProviderHelp) return;
    const helpText = {
      automatic: "Intenta Try on Clothes Pro y, si falla, DataToBiz para una prenda superior.",
      rapidapi: "Usa Try on Clothes Pro directamente; no activa un proveedor alternativo.",
      datatobiz: "DataToBiz admite una sola prenda superior.",
      diffusion: "Try-On Diffusion procesa una prenda por solicitud; no combina prendas.",
      refiner: "Genera primero con Try on Clothes Pro y luego refina; ambas APIs deben estar activas.",
    };
    tryOnProviderHelp.textContent = helpText[tryOnProviderSelect.value] || helpText.automatic;
    if (tryOnGenderField) {
      tryOnGenderField.hidden = tryOnProviderSelect.value !== "refiner";
    }
  };
  tryOnProviderSelect?.addEventListener("change", updateTryOnProviderHelp);
  updateTryOnProviderHelp();
  const paletteStorageKey = "matices-wizard-palette";
  const rememberedPhotoEnabledKey = "matices-photo-remember-enabled";
  const rememberedPhotoDatabase = "matices-local-data";
  const rememberedPhotoStore = "photos";
  const maxRememberedPhotoSize = 10 * 1024 * 1024;
  const tryOnPhotoSessionKey = "calce-try-on-photo-key";
  const tryOnPhotoLifetime = 60 * 60 * 1000;
  let currentPalette = [];
  let currentStep = 1;
  let selectedPhoto = null;
  let tryOnPhotoSavePromise = Promise.resolve(true);
  let cameraStream = null;
  let tryOnPageInitialized = false;
  let tryOnPersonObjectUrl;
  let tryOnProductsController;
  let tryOnRequestController;
  let tryOnCartProducts = [];
  const selectedTryOnCartUrls = new Set();
  let tryOnCartChoicesInitialized = false;
  const tryOnCurrency = new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  });
  const isValidTryOnCartQuantity = product =>
    Number.isSafeInteger(product.quantity) && product.quantity > 0;

  const selectedTryOnProductOptions = () => Array.from(
    tryOnProductSelect?.selectedOptions || [],
  ).filter(option => option.value);

  const updateTryOnCartTotal = () => {
    if (!tryOnCartTotal) return;
    const selectedProducts = tryOnCartProducts.filter(
      product => selectedTryOnCartUrls.has(product.product_url),
    );
    if (selectedProducts.some(
      product => product.store === "Paris" && !isValidTryOnCartQuantity(product),
    )) {
      tryOnCartTotal.textContent = "Revisa cantidades";
      return;
    }
    if (selectedProducts.some(
      product => !Number.isFinite(product.price_clp) || product.price_clp < 0,
    )) {
      tryOnCartTotal.textContent = "No disponible";
      return;
    }
    const priceTotal = selectedProducts.reduce(
      (total, product) => total + product.price_clp * (product.quantity || 1),
      0,
    );
    tryOnCartTotal.textContent = tryOnCurrency.format(priceTotal);
  };

  const updateTryOnCartLink = () => {
    if (!tryOnGoCartLink) return;
    const disabled = tryOnCartProducts.length === 0;
    tryOnGoCartLink.setAttribute("aria-disabled", String(disabled));
    tryOnGoCartLink.tabIndex = disabled ? -1 : 0;
  };
  updateTryOnCartLink();

  const updateTryOnCartChoiceConfirmation = () => {
    const selectedProducts = tryOnCartProducts.filter(
      product => selectedTryOnCartUrls.has(product.product_url),
    );
    if (tryOnCartChoiceConfirmButton) {
      tryOnCartChoiceConfirmButton.disabled = selectedProducts.length === 0
        || selectedProducts.some(
          product => product.store === "Paris" && !isValidTryOnCartQuantity(product),
        );
    }
    updateTryOnCartTotal();
  };

  const renderTryOnCartChoices = () => {
    if (!tryOnCartChoiceList) return;
    tryOnCartChoiceList.replaceChildren();
    tryOnCartProducts.forEach(product => {
      const choice = document.createElement("div");
      choice.className = "try-on-cart-choice";
      choice.dataset.productUrl = product.product_url;
      const selection = document.createElement("label");
      selection.className = "try-on-cart-choice-selection";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = product.product_url;
      checkbox.checked = selectedTryOnCartUrls.has(product.product_url);
      checkbox.setAttribute(
        "aria-label",
        `Agregar ${product.title || "prenda"} al carrito`,
      );
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          selectedTryOnCartUrls.add(product.product_url);
        } else {
          selectedTryOnCartUrls.delete(product.product_url);
        }
        if (tryOnCartChoiceStatus) tryOnCartChoiceStatus.textContent = "";
        updateTryOnCartChoiceConfirmation();
      });

      const image = document.createElement("img");
      image.alt = `Imagen referencial de ${product.title || "prenda"}`;
      image.loading = "lazy";
      image.src = typeof product.image_url === "string"
        && product.image_url.startsWith("https://")
        ? product.image_url
        : "/assets/calce-isotipo.png";

      const details = document.createElement("span");
      details.className = "try-on-cart-choice-details";
      const title = document.createElement("strong");
      title.textContent = product.title || "Prenda";
      const metadata = document.createElement("span");
      const size = product.store === "Vestua"
        ? product.size
        : product.selected_size;
      metadata.textContent = [
        product.store,
        product.brand,
        size ? `Talla ${size}` : "",
      ].filter(Boolean).join(" · ");
      const price = document.createElement("span");
      price.className = "try-on-cart-choice-price";
      price.textContent = Number.isFinite(product.price_clp)
        ? tryOnCurrency.format(product.price_clp)
        : "Precio no disponible";
      details.append(title, metadata, price);
      selection.append(checkbox, image, details);
      choice.append(selection);
      choice.classList.add("has-quantity");
      const quantityLabel = document.createElement("label");
      quantityLabel.className = "try-on-cart-choice-quantity";
      const quantityCaption = document.createElement("span");
      quantityCaption.textContent = "Cantidad a llevar";
      const quantityInput = document.createElement("input");
      quantityInput.type = "number";
      quantityInput.min = "1";
      quantityInput.step = "1";
      quantityInput.inputMode = "numeric";
      quantityInput.setAttribute(
        "aria-label",
        `Cantidad a llevar de ${product.title || "la prenda"}`,
      );
      quantityInput.readOnly = product.store !== "Paris";
      const quantity = isValidTryOnCartQuantity(product) ? product.quantity : 1;
      product.quantity = quantity;
      quantityInput.value = String(quantity);
      if (product.store === "Paris") {
        quantityInput.dataset.tryOnCartQuantity = "";
        quantityInput.dataset.productUrl = product.product_url;
        quantityInput.addEventListener("input", () => {
          const nextQuantity = Number(quantityInput.value);
          const isValid = Number.isSafeInteger(nextQuantity) && nextQuantity > 0;
          quantityInput.setAttribute("aria-invalid", String(!isValid));
          product.quantity = isValid ? nextQuantity : null;
          if (tryOnCartChoiceStatus) {
            tryOnCartChoiceStatus.textContent = isValid
              ? ""
              : "Indica una cantidad válida (mínimo 1) para las prendas de Paris.";
          }
          updateTryOnCartChoiceConfirmation();
        });
      }
      quantityLabel.append(quantityCaption, quantityInput);
      choice.append(quantityLabel);
      tryOnCartChoiceList.append(choice);
    });
    if (tryOnCartChoiceEmpty) {
      tryOnCartChoiceEmpty.hidden = tryOnCartProducts.length > 0;
    }
    if (tryOnCartChoiceStatus) tryOnCartChoiceStatus.textContent = "";
    updateTryOnCartChoiceConfirmation();
  };

  tryOnGoCartLink?.addEventListener("click", event => {
    event.preventDefault();
    if (!tryOnCartProducts.length) return;
    renderTryOnCartChoices();
    if (tryOnCartChoiceDialog && !tryOnCartChoiceDialog.open) {
      tryOnCartChoiceDialog.showModal();
    }
  });

  tryOnCartChoiceCloseButton?.addEventListener(
    "click",
    () => tryOnCartChoiceDialog?.close(),
  );
  tryOnCartChoiceDialog?.addEventListener("click", event => {
    if (event.target === tryOnCartChoiceDialog) tryOnCartChoiceDialog.close();
  });
  tryOnCartChoiceConfirmButton?.addEventListener("click", () => {
    const selectedTryOnProducts = tryOnCartProducts.filter(
      product => selectedTryOnCartUrls.has(product.product_url),
    );
    if (!selectedTryOnProducts.length) {
      if (tryOnCartChoiceStatus) {
        tryOnCartChoiceStatus.textContent = "Selecciona al menos una prenda.";
      }
      return;
    }
    const productMissingQuantity = selectedTryOnProducts.find(
      product => product.store === "Paris" && !isValidTryOnCartQuantity(product),
    );
    if (productMissingQuantity) {
      if (tryOnCartChoiceStatus) {
        tryOnCartChoiceStatus.textContent =
          `Indica una cantidad válida para ${productMissingQuantity.title || "la prenda"}.`;
      }
      tryOnCartChoiceList
        ?.querySelectorAll("[data-try-on-cart-quantity]")
        .forEach(input => {
          if (input.dataset.productUrl === productMissingQuantity.product_url) {
            input.focus();
          }
        });
      return;
    }
    const selectedProducts = selectedTryOnProducts.map(product => ({
      ...product,
      size: product.store === "Vestua"
        ? typeof product.size === "string" ? product.size : ""
        : product.selected_size || "",
      quantity: Number.isSafeInteger(product.quantity) && product.quantity > 0
        ? product.quantity
        : 1,
    }));
    const productMissingSize = selectedProducts.find(
      product => product.store !== "Vestua" &&
        !(typeof product.size === "string" && product.size.trim()),
    );
    if (productMissingSize) {
      if (tryOnCartChoiceStatus) {
        tryOnCartChoiceStatus.textContent =
          `Indica la talla de ${productMissingSize.title || "la prenda"} en Catálogo.`;
      }
      return;
    }
    const detail = { products: selectedProducts };
    window.dispatchEvent(new CustomEvent("calce:add-to-cart", { detail }));
    if (detail.invalidCount) {
      if (tryOnCartChoiceStatus) {
        tryOnCartChoiceStatus.textContent =
          "No se pudieron validar algunas prendas. Vuelve a seleccionarlas desde Catálogo.";
      }
      return;
    }
    if (!detail.saved) {
      if (tryOnCartChoiceStatus) {
        tryOnCartChoiceStatus.textContent =
          "No se pudieron guardar las prendas en el carrito.";
      }
      return;
    }
    if (!clearSelectedCatalogGarments()) {
      if (tryOnCartChoiceStatus) {
        tryOnCartChoiceStatus.textContent =
          "Las prendas se guardaron, pero no se pudo reiniciar la selección del Catálogo.";
      }
      return;
    }
    tryOnCartChoiceDialog?.close();
    tryOnPaymentChoiceDialog?.showModal();
  });

  tryOnPaymentYesButton?.addEventListener("click", () => {
    window.location.assign(tryOnGoCartLink?.href || "/?view=cart");
  });
  tryOnPaymentNoButton?.addEventListener("click", () => {
    window.location.assign(tryOnCatalogLink?.href || "/?view=catalog");
  });

  const setStatus = message => {
    status.textContent = message;
  };

  tryOnTooltipImage?.addEventListener("error", () => {
    tryOnTooltipImage.hidden = true;
    tryOnTooltipTitle.textContent = "Imagen no disponible";
  });

  const syncTryOnPhoto = () => {
    if (tryOnPersonObjectUrl) URL.revokeObjectURL(tryOnPersonObjectUrl);
    tryOnPersonObjectUrl = null;
    if (!selectedPhoto) {
      tryOnPersonPreview.hidden = true;
      tryOnPersonPreview.removeAttribute("src");
      tryOnPersonEmpty.hidden = false;
      if (tryOnGenerateButton) tryOnGenerateButton.disabled = true;
      return;
    }

    tryOnPersonObjectUrl = URL.createObjectURL(selectedPhoto);
    tryOnPersonPreview.src = tryOnPersonObjectUrl;
    tryOnPersonPreview.hidden = false;
    tryOnPersonEmpty.hidden = true;
    if (tryOnGenerateButton) {
      tryOnGenerateButton.disabled = selectedTryOnProductOptions().length === 0;
    }
  };

  const hideTryOnGarmentTooltip = (
    tooltip = tryOnGarmentTooltip,
    image = tryOnTooltipImage,
    titleElement = tryOnTooltipTitle,
  ) => {
    if (!tooltip || !image || !titleElement) return;
    tooltip.hidden = true;
    image.removeAttribute("src");
    titleElement.textContent = "";
  };

  const showTryOnGarmentTooltip = (
    button,
    x,
    y,
    tooltip = tryOnGarmentTooltip,
    image = tryOnTooltipImage,
    titleElement = tryOnTooltipTitle,
  ) => {
    const imageUrl = button.dataset.imageUrl;
    if (
      !imageUrl
      || !tooltip
      || !image
      || !titleElement
    ) return;

    const title = button.dataset.title || button.textContent.trim();
    image.hidden = false;
    image.alt = title;
    image.src = imageUrl;
    titleElement.textContent = title;
    tooltip.hidden = false;

    const bounds = tooltip.getBoundingClientRect();
    const left = Math.max(
      12,
      Math.min(x + 16, window.innerWidth - bounds.width - 12),
    );
    const top = Math.max(
      12,
      Math.min(y + 16, window.innerHeight - bounds.height - 12),
    );
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };

  document.addEventListener("pointermove", event => {
    const target = event.target instanceof Element ? event.target : null;
    if (
      tryOnGarmentTooltip &&
      !tryOnGarmentTooltip.hidden &&
      !target?.closest(".try-on-product-row")
    ) {
      hideTryOnGarmentTooltip();
    }
  });

  const renderTryOnProductOptions = (catalogProducts, emptyMessage) => {
    hideTryOnGarmentTooltip();
    const productsByUrl = new Map(
      readSelectedCatalogGarments().map(product => [product.product_url, product]),
    );
    catalogProducts.forEach(product => {
      if (!product.product_url) return;
      productsByUrl.set(product.product_url, {
        ...productsByUrl.get(product.product_url),
        ...product,
      });
    });
    const products = Array.from(productsByUrl.values());
    tryOnCartProducts = products.filter(product => product.product_url);
    updateTryOnCartLink();
    const availableCartUrls = new Set(
      tryOnCartProducts.map(product => product.product_url),
    );
    selectedTryOnCartUrls.forEach(productUrl => {
      if (!availableCartUrls.has(productUrl)) selectedTryOnCartUrls.delete(productUrl);
    });
    if (!tryOnCartChoicesInitialized) {
      tryOnCartProducts.forEach(product => {
        selectedTryOnCartUrls.add(product.product_url);
      });
      tryOnCartChoicesInitialized = true;
    }
    updateTryOnCartTotal();
    if (tryOnCartChoiceDialog?.open) renderTryOnCartChoices();
    const selectedProductUrls = new Set(
      selectedTryOnProductOptions().map(option => option.value),
    );
    const groups = new Map([
      ["upper_body", { label: "Prendas superiores", options: [], buttons: [] }],
      ["lower_body", { label: "Prendas inferiores", options: [], buttons: [] }],
      ["unsupported", {
        label: "No disponibles para prueba virtual",
        options: [],
        buttons: [],
      }],
    ]);
    products.forEach(product => {
      if (!product.product_url) return;
      const supportsTryOn = ["upper_body", "lower_body", "dresses"]
        .includes(product.category);
      const groupCategory = product.category === "dresses"
        ? "upper_body"
        : ["upper_body", "lower_body"].includes(product.category)
          ? product.category
          : "unsupported";
      const group = groups.get(
        groupCategory,
      );
      if (!group) return;
      const option = document.createElement("option");
      option.value = product.product_url;
      option.textContent = [
        product.store,
        product.brand,
        product.title,
        product.size ? `Talla ${product.size}` : "",
      ].filter(Boolean).join(" · ");
      option.disabled = !supportsTryOn;
      if (product.image_url) option.dataset.imageUrl = product.image_url;
      if (product.title) option.dataset.title = product.title;
      if (product.category) option.dataset.category = product.category;
      option.selected = selectedProductUrls.has(product.product_url);
      group.options.push(option);

      const row = document.createElement("div");
      row.className = "try-on-product-row";
      row.dataset.imageUrl = product.image_url || "";
      row.dataset.title = product.title || "";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "try-on-product-option";
      button.dataset.vtonProductOption = "";
      button.dataset.productUrl = product.product_url;
      button.textContent = supportsTryOn
        ? option.textContent
        : `${option.textContent} · No disponible para prueba`;
      button.disabled = !supportsTryOn;
      if (!supportsTryOn) {
        button.title = "Esta categoría no es compatible con los proveedores del Probador.";
      }
      button.setAttribute(
        "aria-pressed",
        String(selectedProductUrls.has(product.product_url)),
      );
      if (product.image_url) button.dataset.imageUrl = product.image_url;
      if (product.title) button.dataset.title = product.title;
      if (product.category) button.dataset.category = product.category;
      button.setAttribute("aria-describedby", "vton-garment-tooltip");
      button.addEventListener("click", () => {
        const selectedOption = Array.from(tryOnProductSelect.options)
          .find(candidate => candidate.value === product.product_url);
        if (!selectedOption) {
          tryOnStatus.textContent = "No se pudo seleccionar esa prenda. Recarga el Probador.";
          console.error("La prenda no está disponible en el selector del Probador.");
          return;
        }
        if (selectedOption.selected) {
          selectedOption.selected = false;
        } else {
          const canCombine = ["upper_body", "lower_body"].includes(
            product.category,
          );
          selectedTryOnProductOptions().forEach(existingOption => {
            const existingCanCombine = [
              "upper_body",
              "lower_body",
            ].includes(existingOption.dataset.category);
            if (
              !canCombine
              || !existingCanCombine
              || existingOption.dataset.category === product.category
            ) {
              existingOption.selected = false;
            }
          });
          selectedOption.selected = true;
        }
        const selectedProductUrls = new Set(
          selectedTryOnProductOptions().map(option => option.value),
        );
        tryOnProductList.querySelectorAll("[data-vton-product-option]")
          .forEach(productButton => {
            productButton.setAttribute(
              "aria-pressed",
              String(selectedProductUrls.has(productButton.dataset.productUrl)),
            );
          });
        tryOnProductSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      button.addEventListener("focus", () => {
        const bounds = button.getBoundingClientRect();
        showTryOnGarmentTooltip(row, bounds.right, bounds.top);
      });
      button.addEventListener("blur", hideTryOnGarmentTooltip);

      row.addEventListener("pointerenter", event => {
        showTryOnGarmentTooltip(row, event.clientX, event.clientY);
      });
      row.addEventListener("pointermove", event => {
        showTryOnGarmentTooltip(row, event.clientX, event.clientY);
      });
      row.addEventListener("pointerleave", hideTryOnGarmentTooltip);
      row.append(button);
      group.buttons.push(row);
    });
    const productCount = Array.from(groups.values()).reduce(
      (count, group) => count + group.options.length,
      0,
    );

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.disabled = true;
    placeholder.textContent = productCount
      ? "Selecciona una prenda"
      : emptyMessage;
    const optionGroups = Array.from(groups.values())
      .filter(group => group.options.length)
      .map(group => {
        const optgroup = document.createElement("optgroup");
        optgroup.label = group.label;
        optgroup.append(...group.options);
        return optgroup;
      });
    groups.forEach((group, category) => {
      const optionsContainer = tryOnProductList.querySelector(
        `[data-vton-product-options="${category}"]`,
      );
      if (!optionsContainer) return;
      if (category === "unsupported") {
        optionsContainer.closest("[data-vton-product-group]").hidden =
          group.buttons.length === 0;
      }
      if (group.buttons.length) {
        optionsContainer.replaceChildren(...group.buttons);
        return;
      }
      if (category === "unsupported") {
        optionsContainer.replaceChildren();
        return;
      }
      const empty = document.createElement("p");
      empty.className = "try-on-product-empty";
      empty.textContent = productCount
        ? `Aún no hay ${category === "upper_body" ? "prendas superiores" : "prendas inferiores"}.`
        : emptyMessage;
      optionsContainer.replaceChildren(empty);
    });
    tryOnProductSelect.replaceChildren(placeholder, ...optionGroups);
    tryOnProductSelect.disabled = false;
    tryOnProductSelect.dispatchEvent(new Event("change"));
  };

  const loadInitialTryOnProducts = async () => {
    const savedProducts = readSelectedCatalogGarments();
    const productsNeedingMetadata = savedProducts.filter(
      product => !product.category || !Number.isFinite(product.price_clp),
    );
    if (!productsNeedingMetadata.length) {
      renderTryOnProductOptions(
        [],
        "Selecciona una prenda desde Catálogo",
      );
      return;
    }

    tryOnProductsController?.abort();
    tryOnProductsController = new AbortController();
    const params = new URLSearchParams();
    productsNeedingMetadata.slice(0, 24).forEach(product => {
      params.append("product_url", product.product_url);
    });
    try {
      const response = await fetch(`/api/vton-products?${params}`, {
        signal: tryOnProductsController.signal,
      });
      const data = await readJsonResponse(response, "Prendas seleccionadas");
      if (!response.ok) {
        throw new Error(data.error || `El servidor respondió HTTP ${response.status}.`);
      }
      renderTryOnProductOptions(
        data.products || [],
        "Selecciona una prenda desde Catálogo",
      );
    } catch (error) {
      if (error.name === "AbortError") return;
      renderTryOnProductOptions(
        [],
        "Selecciona una prenda desde Catálogo",
      );
      tryOnStatus.textContent = "No se pudieron cargar las prendas guardadas. Inténtalo nuevamente.";
      console.error("No se pudieron recuperar las prendas del catálogo.", error);
    }
  };

  tryOnLink?.addEventListener("click", async event => {
    event.preventDefault();
    await tryOnPhotoSavePromise;
    window.location.assign(tryOnLink.href);
  });

  tryOnProductSelect?.addEventListener("change", () => {
    if (tryOnGenerateButton) {
      tryOnGenerateButton.disabled = (
        !selectedPhoto || selectedTryOnProductOptions().length === 0
      );
    }
    tryOnResult.hidden = true;
  });

  const initializeTryOnPage = () => {
    if (!tryOnPagePanel || tryOnPagePanel.hidden || tryOnPageInitialized) return;
    tryOnPageInitialized = true;
    syncTryOnPhoto();
    void loadInitialTryOnProducts();
  };
  window.addEventListener("calce:protected-page-visible", event => {
    if (event.detail?.view === "try-on") initializeTryOnPage();
  });
  initializeTryOnPage();

  const fileAsBase64 = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      const separator = dataUrl.indexOf(",");
      if (separator < 0) {
        reject(new Error("No se pudo codificar la foto de Inicio."));
        return;
      }
      resolve(dataUrl.slice(separator + 1));
    };
    reader.onerror = () => reject(reader.error || new Error("No se pudo leer la foto de Inicio."));
    reader.readAsDataURL(file);
  });

  const optimizeTryOnPhoto = async file => {
    const bitmap = await createImageBitmap(file);
    try {
      const maxDimension = 1024;
      const scale = Math.min(
        1,
        maxDimension / Math.max(bitmap.width, bitmap.height),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("No se pudo preparar la foto para el Probador.");
      }
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve, reject) => {
        canvas.toBlob(
          blob => blob
            ? resolve(blob)
            : reject(new Error("No se pudo comprimir la foto para el Probador.")),
          "image/jpeg",
          0.82,
        );
      });
    } finally {
      bitmap.close();
    }
  };

  tryOnGenerateButton?.addEventListener("click", async () => {
    const productUrls = selectedTryOnProductOptions().map(option => option.value);
    const provider = tryOnProviderSelect?.value || "automatic";
    if (!tryOnProductSelect) {
      tryOnStatus.textContent = "No se pudo cargar el selector de prendas. Recarga la página.";
      console.error("No se encontró el selector de prendas del Probador.");
      return;
    }
    if (!selectedPhoto || !productUrls.length) {
      tryOnStatus.textContent = "Selecciona una foto en Inicio y al menos una prenda.";
      return;
    }
    if (selectedPhoto.size > 10 * 1024 * 1024) {
      tryOnStatus.textContent = "La foto debe tener un tamaño máximo de 10 MB.";
      return;
    }

    tryOnRequestController?.abort();
    tryOnRequestController = new AbortController();
    const timeout = window.setTimeout(() => tryOnRequestController.abort(), 600000);
    tryOnGenerateButton.disabled = true;
    tryOnResult.hidden = true;
    tryOnStatus.textContent = "Preparando la foto y la sesión…";
    try {
      const [accessToken, optimizedPhoto] = await Promise.all([
        window.calceGetAccessToken?.(),
        optimizeTryOnPhoto(selectedPhoto),
      ]);
      if (!accessToken) {
        tryOnStatus.textContent = "Inicia sesión para usar el Probador.";
        return;
      }
      const personImageBase64 = await fileAsBase64(optimizedPhoto);
      const providerStatus = {
        automatic: "Generando la prueba virtual…",
        rapidapi: "Generando con Try on Clothes Pro…",
        datatobiz: "Generando directamente con DataToBiz…",
        diffusion: "Generando directamente con Try-On Diffusion…",
        refiner: "Generando y refinando con dos APIs…",
      };
      tryOnStatus.textContent = providerStatus[provider] || providerStatus.automatic;
      const response = await fetch("/api/try-on", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          person_image_base64: personImageBase64,
          product_urls: productUrls,
          provider,
          gender: tryOnGenderSelect?.value || "woman",
        }),
        signal: tryOnRequestController.signal,
      });
      const data = await readJsonResponse(response, "Probador");
      if (!response.ok) {
        throw new Error(data.error || `El servidor respondió HTTP ${response.status}.`);
      }
      let resultImageSource;
      if (typeof data.result_image_url === "string") {
        const resultUrl = new URL(data.result_image_url);
        if (resultUrl.protocol !== "https:") {
          throw new Error("El proveedor devolvió una URL de imagen no segura.");
        }
        resultImageSource = resultUrl.href;
      } else if (
        typeof data.result_image_data_url === "string"
        && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/
          .test(data.result_image_data_url)
      ) {
        resultImageSource = data.result_image_data_url;
      } else {
        throw new Error("El proveedor no devolvió una imagen válida.");
      }
      tryOnResultImage.src = resultImageSource;
      tryOnResultStatus.textContent = data.detail || "Prueba virtual completada.";
      tryOnResult.hidden = false;
      tryOnStatus.textContent = data.status === "simulation"
        ? "Modo simulación: todavía no se ha integrado la inferencia del modelo VTON."
        : "Prueba virtual completada.";
    } catch (error) {
      tryOnStatus.textContent = error.name === "AbortError"
        ? "La solicitud tardó demasiado y se canceló. Inténtalo nuevamente."
        : error.message || "No se pudo completar la prueba virtual.";
      console.error(
        "No se pudo completar la prueba virtual con los proveedores disponibles.",
        error,
      );
    } finally {
      window.clearTimeout(timeout);
      if (tryOnGenerateButton) {
        tryOnGenerateButton.disabled = (
          !selectedPhoto || selectedTryOnProductOptions().length === 0
        );
      }
    }
  });

  const openPhotoDatabase = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(rememberedPhotoDatabase, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(rememberedPhotoStore);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("No se pudo abrir el almacenamiento local de fotos."));
    request.onblocked = () => reject(new Error("El almacenamiento local de fotos está bloqueado por otra pestaña."));
  });

  const saveRememberedPhoto = async file => {
    const database = await openPhotoDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(rememberedPhotoStore, "readwrite");
        transaction.objectStore(rememberedPhotoStore).put({
          blob: file,
          name: file.name,
          type: file.type,
          lastModified: file.lastModified,
        }, "selected-photo");
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("No se pudo guardar la foto."));
        transaction.onabort = () => reject(transaction.error || new Error("Se canceló el guardado de la foto."));
      });
    } finally {
      database.close();
    }
  };

  const loadRememberedPhoto = async () => {
    const database = await openPhotoDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(rememberedPhotoStore, "readonly");
        const request = transaction.objectStore(rememberedPhotoStore).get("selected-photo");
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error("No se pudo recuperar la foto guardada."));
      });
    } finally {
      database.close();
    }
  };

  const deleteRememberedPhoto = async () => {
    const database = await openPhotoDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(rememberedPhotoStore, "readwrite");
        transaction.objectStore(rememberedPhotoStore).delete("selected-photo");
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("No se pudo borrar la foto guardada."));
        transaction.onabort = () => reject(transaction.error || new Error("Se canceló el borrado de la foto."));
      });
    } finally {
      database.close();
    }
  };

  const getTryOnPhotoKey = () => {
    let key = sessionStorage.getItem(tryOnPhotoSessionKey);
    if (!key) {
      key = `try-on-session-${crypto.randomUUID()}`;
      sessionStorage.setItem(tryOnPhotoSessionKey, key);
    }
    return key;
  };

  const saveTryOnPhotoForSession = async file => {
    const key = getTryOnPhotoKey();
    const database = await openPhotoDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(rememberedPhotoStore, "readwrite");
        transaction.objectStore(rememberedPhotoStore).put({
          blob: file,
          name: file.name,
          type: file.type,
          lastModified: file.lastModified,
          expiresAt: Date.now() + tryOnPhotoLifetime,
        }, key);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(
          transaction.error || new Error("No se pudo conservar la foto para el Probador.")
        );
        transaction.onabort = () => reject(
          transaction.error || new Error("Se canceló la preparación de la foto para el Probador.")
        );
      });
    } finally {
      database.close();
    }
  };

  const loadTryOnPhotoForSession = async () => {
    const key = sessionStorage.getItem(tryOnPhotoSessionKey);
    if (!key) return null;
    const database = await openPhotoDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(rememberedPhotoStore, "readonly");
        const request = transaction.objectStore(rememberedPhotoStore).get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(
          request.error || new Error("No se pudo recuperar la foto para el Probador.")
        );
      });
    } finally {
      database.close();
    }
  };

  const removeTryOnPhotoForSession = async () => {
    const key = sessionStorage.getItem(tryOnPhotoSessionKey);
    sessionStorage.removeItem(tryOnPhotoSessionKey);
    if (!key) return;
    const database = await openPhotoDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(rememberedPhotoStore, "readwrite");
        transaction.objectStore(rememberedPhotoStore).delete(key);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(
          transaction.error || new Error("No se pudo eliminar la foto temporal.")
        );
      });
    } finally {
      database.close();
    }
  };

  const cleanExpiredTryOnPhotos = async () => {
    const database = await openPhotoDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(rememberedPhotoStore, "readwrite");
        const cursorRequest = transaction.objectStore(rememberedPhotoStore).openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const value = cursor.value;
          if (
            typeof cursor.key === "string"
            && cursor.key.startsWith("try-on-session-")
            && Number(value?.expiresAt) <= Date.now()
          ) {
            cursor.delete();
          }
          cursor.continue();
        };
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(
          transaction.error || new Error("No se pudieron limpiar fotos temporales.")
        );
      });
    } finally {
      database.close();
    }
  };

  const persistSelectedPhoto = async (file, notifyAccount = true) => {
    if (!rememberBox?.checked) return;
    if (notifyAccount) {
      window.dispatchEvent(new CustomEvent("matices:photo-selected", {
        detail: { file },
      }));
    }
    try {
      localStorage.setItem(rememberedPhotoEnabledKey, "true");
      await saveRememberedPhoto(file);
      rememberStatus.textContent = file.size > maxRememberedPhotoSize
        ? "Foto guardada en este navegador; supera el límite de 10 MB para la cuenta."
        : "Foto guardada en este navegador.";
    } catch (error) {
      rememberStatus.textContent = "No se pudo guardar la foto en este navegador.";
      console.error("No se pudo guardar la foto recordada.", error);
    }
  };

  const stopCamera = () => {
    cameraStream?.getTracks().forEach(track => track.stop());
    cameraStream = null;
    if (cameraVideo) cameraVideo.srcObject = null;
    if (cameraPanel) cameraPanel.hidden = true;
    if (cameraButton) cameraButton.disabled = false;
  };

  const showSelectedPhoto = (file, persist = true, resetAnalysis = true) => {
    selectedPhoto = file;
    tryOnPhotoSavePromise = saveTryOnPhotoForSession(file)
      .then(() => true)
      .catch(error => {
        console.error("No se pudo conservar la foto para el Probador.", error);
        if (rememberStatus) {
          rememberStatus.textContent = "La foto no se pudo preparar para el Probador en esta sesión.";
        }
        return false;
      });
    syncTryOnPhoto();
    nextButton.disabled = true;
    if (resetAnalysis) {
      currentPalette = [];
      window.dispatchEvent(new CustomEvent("matices:palette-updated"));
      paletteSummaryStatus.textContent = "Completa el análisis de la foto para ver tu paleta.";
      paletteSummaryColors.replaceChildren();
      try {
        sessionStorage.removeItem(paletteStorageKey);
      } catch (error) {
        console.error("No se pudo limpiar la paleta anterior de la sesión.", error);
      }
    }

    const reader = new FileReader();
    reader.onload = () => {
      preview.src = reader.result;
      previewBox.hidden = false;
      rememberRow.hidden = false;
      nextButton.disabled = false;
      setStatus("");
      if (persist) persistSelectedPhoto(file);
    };
    reader.onerror = () => {
      selectedPhoto = null;
      previewBox.hidden = true;
      rememberRow.hidden = true;
      setStatus("No se pudo mostrar la foto. Intenta seleccionarla nuevamente.");
    };
    reader.readAsDataURL(file);
  };

  const restoreRememberedPhoto = async () => {
    try {
      await window.calceAuthStateReady;
      if (window.calceAuthenticated) return;
      rememberBox.checked = false;
      localStorage.removeItem(rememberedPhotoEnabledKey);
      await deleteRememberedPhoto();
    } catch (error) {
      rememberStatus.textContent = "No se pudo limpiar una foto local sin sesión.";
      console.error("No se pudo limpiar una foto local de sesión anónima.", error);
    }
  };

  const removeSelectedPhoto = () => {
    window.dispatchEvent(new CustomEvent("matices:photo-removed"));
    selectedPhoto = null;
    syncTryOnPhoto();
    removeTryOnPhotoForSession().catch(error => {
      console.error("No se pudo eliminar la foto temporal del Probador.", error);
    });
    if (fileInput) fileInput.value = "";
    if (preview) preview.removeAttribute("src");
    if (previewBox) previewBox.hidden = true;
    if (rememberRow) rememberRow.hidden = true;
    if (rememberBox) rememberBox.checked = false;
    if (rememberStatus) rememberStatus.textContent = "Eliminando la foto guardada…";
    if (nextButton) nextButton.disabled = true;
    currentPalette = [];
    window.dispatchEvent(new CustomEvent("matices:palette-updated"));
    paletteSummaryStatus.textContent = "Completa el análisis de la foto para ver tu paleta.";
    paletteSummaryColors.replaceChildren();
    try {
      sessionStorage.removeItem(paletteStorageKey);
    } catch (error) {
      console.error("No se pudo eliminar la paleta asociada a la foto.", error);
    }
    try {
      localStorage.removeItem(rememberedPhotoEnabledKey);
      deleteRememberedPhoto().then(() => {
        if (rememberStatus) rememberStatus.textContent = "Foto eliminada del navegador.";
      }).catch(error => {
        if (rememberStatus) rememberStatus.textContent = "No se pudo borrar la foto guardada.";
        console.error("No se pudo borrar la foto recordada.", error);
      });
    } catch (error) {
      if (rememberStatus) rememberStatus.textContent = "No se pudo borrar la foto guardada.";
      console.error("No se pudo borrar la preferencia de foto.", error);
    }
    setStatus("Imagen eliminada. Puedes elegir o tomar otra foto.");
  };

  window.addEventListener("matices:clear-account-data", () => {
    removeSelectedPhoto();
  });

  const updateProgress = step => {
    const steps = Math.max(1, wizardSteps.length);
    const progress = (step / steps) * 100;
    if (progressFill) progressFill.style.width = `${progress}%`;
    if (progressBar) progressBar.setAttribute("aria-valuenow", String(step));
    wizardSteps.forEach((step, index) => {
      step.classList.toggle("is-active", index < currentStep);
    });
  };

  const showStep = step => {
    currentStep = Math.max(1, Math.min(step, panels.length));
    wizard.classList.remove("is-account-view");
    wizard.closest("#home-panel")?.classList.remove("is-account-view");
    if (accountPanel) accountPanel.hidden = true;
    if (currentStep !== 1) stopCamera();
    panels.forEach(panel => {
      panel.hidden = Number(panel.dataset.wizardPanel) !== currentStep;
    });
    const resultsPanel = document.querySelector(".wizard-page-results");
    if (resultsPanel) resultsPanel.hidden = currentStep !== panels.length;
    if (stepInput) stepInput.value = String(currentStep);
    updateProgress(currentStep);
    accountLinks.forEach(link => link.removeAttribute("aria-current"));
    document.getElementById("home-link")?.setAttribute("aria-current", "page");
    wizard.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const showAccount = () => {
    if (!accountPanel) return;
    stopCamera();
    wizard.classList.add("is-account-view");
    wizard.closest("#home-panel")?.classList.add("is-account-view");
    panels.forEach(panel => {
      panel.hidden = true;
    });
    accountPanel.hidden = false;
    const resultsPanel = document.querySelector(".wizard-page-results");
    if (resultsPanel) resultsPanel.hidden = true;
    document.getElementById("home-link")?.removeAttribute("aria-current");
    document.getElementById("catalog-link")?.removeAttribute("aria-current");
    const selectedAuthMode = accountLinks.find(
      link => link.getAttribute("aria-current") === "page",
    )?.dataset.openAccount
      || (new URLSearchParams(window.location.search).get("auth_mode") === "sign-up"
        ? "sign-up"
        : "sign-in");
    accountLinks.forEach(link => {
      if (link.dataset.openAccount === selectedAuthMode) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    });
    wizard.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  window.addEventListener("calce:open-account", () => {
    showAccount();
  });

  const rgbToHex = (r, g, b) => [r, g, b].map(value => value.toString(16).padStart(2, "0")).join("").toUpperCase();

  const rgbToHsl = (r, g, b) => {
    const red = r / 255;
    const green = g / 255;
    const blue = b / 255;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;
    const l = (max + min) / 2;

    let h = 0;
    let s = 0;
    if (delta !== 0) {
      s = delta / (1 - Math.abs(2 * l - 1));
      switch (max) {
        case red: h = ((green - blue) / delta) % 6; break;
        case green: h = (blue - red) / delta + 2; break;
        default: h = (red - green) / delta + 4; break;
      }
      h *= 60;
      if (h < 0) h += 360;
    }

    return { h, s, l };
  };

  const colorNameFromHex = hex => {
    const rgb = hex.replace("#", "");
    const [r, g, b] = [0, 2, 4].map(index => Number.parseInt(rgb.slice(index, index + 2), 16));
    const { h, s, l } = rgbToHsl(r, g, b);

    if (s < 0.18 && l > 0.7) return "Beige claro";
    if (s < 0.18 && l < 0.35) return "Marrón oscuro";
    if (h >= 330 || h < 20) return "Terracota";
    if (h >= 20 && h < 50) return "Marrón cálido";
    if (h >= 50 && h < 90) return "Mostaza / verde oliva";
    if (h >= 90 && h < 160) return "Verde natural";
    if (h >= 160 && h < 220) return "Azul / verde frío";
    if (h >= 220 && h < 290) return "Morado / lavanda";
    return "Rosa / rubor";
  };

  const updateSizeSummary = () => {
    const enteredMeasures = readEnteredSizeMeasures();

    sizeSummaryMeasures.replaceChildren(...enteredMeasures.map(({ label, value }) => {
      const item = document.createElement("li");
      item.textContent = `${label}: ${new Intl.NumberFormat("es-CL", {
        maximumFractionDigits: 1,
      }).format(value)} cm`;
      return item;
    }));
    sizeSummarySizes.replaceChildren();

    if (!enteredMeasures.length) {
      sizeSummaryStatus.textContent = "Completa tus medidas para consultar tallas compatibles o cercanas.";
      return;
    }

    const recommendation = getParisSizeFitContext(enteredMeasures).recommendation;
    if (!recommendation.sizes.length) {
      sizeSummaryStatus.textContent = "No se pudieron estimar tallas con estas medidas.";
      return;
    }

    sizeSummaryStatus.textContent = recommendation.exactMatch
      ? "Tallas compatibles con las medidas ingresadas:"
      : "Tallas más cercanas; tus medidas no coinciden todas con un mismo rango:";
    recommendation.sizes.forEach(sizeData => {
      const size = document.createElement("span");
      size.className = "wizard-summary-size";
      size.textContent = [
        sizeData.dataset.sizeLabel,
        sizeData.dataset.sizeEu && `EU ${sizeData.dataset.sizeEu}`,
        sizeData.dataset.sizeUs && `EE. UU. ${sizeData.dataset.sizeUs}`,
      ].filter(Boolean).join(" · ");
      sizeSummarySizes.append(size);
    });
  };

  const applyAnalysis = palette => {
    currentPalette = palette;
    const average = palette.reduce((sum, item) => {
      const [r, g, b] = item.rgb;
      const { h, s, l } = rgbToHsl(r, g, b);
      sum.h += h;
      sum.s += s;
      sum.l += l;
      return sum;
    }, { h: 0, s: 0, l: 0 });

    const averageH = average.h / palette.length;
    const averageL = average.l / palette.length;
    const imageDepth = averageL < 0.32 ? "Muy profundo" : averageL < 0.5 ? "Profundo" : averageL < 0.68 ? "Medio" : "Claro";
    const undertone = averageH >= 330 || averageH < 30
      ? "Cálido"
      : averageH >= 30 && averageH < 200
        ? "Neutro"
        : "Frío";

    paletteSummaryStatus.textContent = `Subtono ${undertone.toLowerCase()} · profundidad ${imageDepth.toLowerCase()}. La iluminación, el fondo y la ropa pueden influir en el resultado.`;
    paletteSummaryColors.replaceChildren(...palette.map(item => {
      const color = document.createElement("span");
      const swatch = document.createElement("span");
      const label = document.createElement("span");
      const name = colorNameFromHex(item.hex);
      color.className = "wizard-summary-color";
      swatch.className = "wizard-summary-color-swatch";
      swatch.style.backgroundColor = item.hex;
      label.textContent = name;
      color.append(swatch, label);
      return color;
    }));
    try {
      sessionStorage.setItem(paletteStorageKey, JSON.stringify(palette));
    } catch (error) {
      console.error("No se pudo conservar la paleta durante la sesión.", error);
    }
    window.dispatchEvent(new CustomEvent("matices:palette-updated", {
      detail: { palette },
    }));
  };

  const analyzeSelectedImage = () => new Promise(resolve => {
    const file = selectedPhoto;
    if (!file || !file.type.startsWith("image/")) {
      setStatus("Sube una foto para analizar tu paleta.");
      resolve(false);
      return;
    }

    const image = new Image();
    image.decoding = "async";
    const reader = new FileReader();

    reader.onload = () => {
      setStatus("Analizando tonos y profundidad...");
      image.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          const maxDimension = 220;
          const scale = Math.min(maxDimension / image.width, maxDimension / image.height, 1);
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          const context = canvas.getContext("2d");
          if (!context) throw new Error("No se pudo preparar el análisis de la foto.");
          context.drawImage(image, 0, 0, canvas.width, canvas.height);

          const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
          const buckets = new Map();

          for (let i = 0; i < data.length; i += 4) {
            const alpha = data[i + 3];
            if (alpha < 180) continue;
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const luminance = (r * 0.299) + (g * 0.587) + (b * 0.114);
            if (luminance < 20 || luminance > 245) continue;
            const key = `${Math.round(r / 24) * 24}-${Math.round(g / 24) * 24}-${Math.round(b / 24) * 24}`;
            buckets.set(key, (buckets.get(key) || 0) + 1);
          }

          const palette = [...buckets.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([key, count]) => {
              const [r, g, b] = key.split("-").map(Number);
              return { rgb: [r, g, b], hex: `#${rgbToHex(r, g, b)}`, count };
            });

          if (!palette.length) {
            setStatus("No se pudo detectar una paleta clara. Prueba con otra imagen.");
            resolve(false);
            return;
          }

          applyAnalysis(palette);
          setStatus("Análisis listo. Revisa el resumen de paleta y medidas.");
          resolve(true);
        } catch (error) {
          setStatus("No se pudo analizar la foto. Intenta con otra imagen.");
          console.error("No se pudo analizar la foto.", error);
          resolve(false);
        }
      };
      image.onerror = () => {
        setStatus("No se pudo abrir la foto. Selecciona otra imagen.");
        resolve(false);
      };
      image.src = reader.result;
    };
    reader.onerror = () => {
      setStatus("No se pudo leer la foto. Intenta seleccionarla nuevamente.");
      resolve(false);
    };
    reader.readAsDataURL(file);
  });

  fileInput?.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    stopCamera();
    showSelectedPhoto(file);
  });
  removePhotoButton?.addEventListener("click", removeSelectedPhoto);
  cameraButton?.addEventListener("click", async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("La cámara requiere un navegador compatible y una conexión segura (HTTPS o localhost). Puedes elegir una foto del dispositivo.");
      return;
    }

    cameraButton.disabled = true;
    setStatus("Solicitando permiso para usar la cámara...");
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "user" },
      });
      cameraVideo.srcObject = cameraStream;
      cameraPanel.hidden = false;
      await cameraVideo.play();
      setStatus("Encuadra tu rostro y presiona Capturar foto.");
    } catch (error) {
      stopCamera();
      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        setStatus("No se concedió permiso para usar la cámara. Autoriza el acceso en el navegador o elige una foto del dispositivo.");
      } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
        setStatus("No se encontró una cámara disponible. Puedes elegir una foto del dispositivo.");
      } else {
        setStatus("No se pudo iniciar la cámara. Revisa los permisos o elige una foto del dispositivo.");
        console.error("No se pudo iniciar la cámara.", error);
      }
    }
  });

  captureButton?.addEventListener("click", () => {
    if (!cameraStream || !cameraVideo.videoWidth || !cameraVideo.videoHeight) {
      setStatus("La cámara aún no está lista. Espera un momento e inténtalo nuevamente.");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = cameraVideo.videoWidth;
    canvas.height = cameraVideo.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      setStatus("No se pudo capturar la foto. Puedes elegir una imagen del dispositivo.");
      return;
    }
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
    context.drawImage(cameraVideo, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(blob => {
      if (!blob) {
        setStatus("No se pudo guardar la foto capturada. Inténtalo nuevamente.");
        return;
      }
      stopCamera();
      showSelectedPhoto(new File([blob], "foto-camara.jpg", { type: "image/jpeg" }));
    }, "image/jpeg", 0.92);
  });

  cancelCameraButton?.addEventListener("click", () => {
    stopCamera();
    setStatus(selectedPhoto
      ? "Se conserva la foto seleccionada. Puedes usarla o elegir otra."
      : "Cámara cerrada. Puedes tomar otra foto o elegir una del dispositivo.");
  });

  nextButton?.addEventListener("click", async () => {
    nextButton.disabled = true;
    const analyzed = await analyzeSelectedImage();
    nextButton.disabled = !selectedPhoto;
    if (analyzed) showStep(2);
  });
  wizard.querySelectorAll("[data-wizard-next]").forEach(button => {
    button.addEventListener("click", () => {
      showStep(Number(button.dataset.wizardNext));
    });
  });
  wizard.querySelectorAll("[data-wizard-back]").forEach(button => {
    button.addEventListener("click", () => {
      const activePanel = button.closest("[data-wizard-panel]");
      showStep(Number(activePanel.dataset.wizardPanel) - 1);
    });
  });

  rememberBox?.addEventListener("change", async () => {
    if (!rememberStatus) return;
    window.dispatchEvent(new CustomEvent("matices:photo-remember-changed", {
      detail: {
        enabled: rememberBox.checked,
        file: rememberBox.checked ? selectedPhoto : null,
      },
    }));
    if (rememberBox.checked) {
      try {
        localStorage.setItem(rememberedPhotoEnabledKey, "true");
        if (selectedPhoto) {
          await persistSelectedPhoto(selectedPhoto, false);
        } else {
          rememberStatus.textContent = "La próxima foto se guardará en este navegador.";
        }
      } catch (error) {
        rememberStatus.textContent = "No se pudo activar el recuerdo de la foto.";
        console.error("No se pudo activar el recuerdo de la foto.", error);
      }
      return;
    }

    try {
      localStorage.removeItem(rememberedPhotoEnabledKey);
      await deleteRememberedPhoto();
      rememberStatus.textContent = "La foto guardada se eliminó de este navegador.";
    } catch (error) {
      rememberStatus.textContent = "No se pudo eliminar la foto guardada.";
      console.error("No se pudo desactivar el recuerdo de la foto.", error);
    }
  });

  window.addEventListener("matices:restore-photo", event => {
    const file = event.detail?.file;
    if (!(file instanceof File)) return;
    rememberBox.checked = true;
    try {
      localStorage.setItem(rememberedPhotoEnabledKey, "true");
    } catch (error) {
      rememberStatus.textContent = "Foto recuperada de tu cuenta, pero no se pudo recordar en este navegador.";
      console.error("No se pudo guardar la preferencia local de la foto.", error);
    }
    saveRememberedPhoto(file)
      .then(() => {
        showSelectedPhoto(file, false, false);
        rememberStatus.textContent = "";
      })
      .catch(error => {
        showSelectedPhoto(file, false, false);
        rememberStatus.textContent = "Foto recuperada de tu cuenta, pero no se pudo guardar en este navegador.";
        console.error("No se pudo conservar localmente la foto de la cuenta.", error);
      });
  });

  wizardForm?.querySelectorAll(".measurement-input").forEach(field => {
    field.addEventListener("input", updateSizeSummary);
  });

  let preparingWizardSubmission = false;
  let resubmittingWizardForm = false;
  wizardForm?.addEventListener("submit", async event => {
    if (resubmittingWizardForm) {
      resubmittingWizardForm = false;
      if (stepInput) stepInput.value = "3";
      try {
        sessionStorage.setItem(paletteStorageKey, JSON.stringify(currentPalette));
      } catch (error) {
        console.error("No se pudo conservar la paleta durante la sesión.", error);
      }
      return;
    }

    event.preventDefault();
    if (preparingWizardSubmission) return;
    preparingWizardSubmission = true;
    const submitter = event.submitter;
    const photoSaved = await tryOnPhotoSavePromise;
    if (!photoSaved && rememberStatus) {
      rememberStatus.textContent = "La foto no se conservará al navegar al catálogo; vuelve a Inicio para probarla.";
    }
    try {
      resubmittingWizardForm = true;
      if (submitter) wizardForm.requestSubmit(submitter);
      else wizardForm.requestSubmit();
    } catch (error) {
      resubmittingWizardForm = false;
      setStatus("No se pudo continuar al catálogo. Inténtalo nuevamente.");
      console.error("No se pudo enviar el formulario del asistente.", error);
    } finally {
      preparingWizardSubmission = false;
    }
  });

  window.addEventListener("matices:restore-palette", event => {
    const palette = event.detail?.palette;
    if (Array.isArray(palette) && palette.length === 0) {
      currentPalette = [];
      paletteSummaryStatus.textContent = "Completa el análisis de la foto para ver tu paleta.";
      paletteSummaryColors.replaceChildren();
      try {
        sessionStorage.setItem(paletteStorageKey, "[]");
      } catch (error) {
        console.error("No se pudo limpiar la paleta recuperada.", error);
      }
      return;
    }
    if (
      Array.isArray(palette)
      && palette.length > 0
      && palette.every(item =>
        typeof item?.hex === "string"
        && Array.isArray(item.rgb)
        && item.rgb.length === 3
        && item.rgb.every(Number.isFinite)
      )
    ) {
      applyAnalysis(palette);
    }
  });

  try {
    const storedPalette = JSON.parse(sessionStorage.getItem(paletteStorageKey) || "[]");
    if (
      Array.isArray(storedPalette)
      && storedPalette.length > 0
      && storedPalette.every(item =>
        typeof item?.hex === "string"
        && Array.isArray(item.rgb)
        && item.rgb.length === 3
        && item.rgb.every(Number.isFinite)
      )
    ) {
      applyAnalysis(storedPalette);
    }
  } catch (error) {
    console.error("No se pudo recuperar la paleta de esta sesión.", error);
  }

  const requestedStep = Number(stepInput?.value);
  const initialStep = requestedStep === 2 || (requestedStep === 3 && currentPalette.length)
    ? Math.min(requestedStep, panels.length)
    : 1;
  updateSizeSummary();
  showStep(initialStep);
  if (new URLSearchParams(window.location.search).get("view") === "account") {
    showAccount();
  }
  cleanExpiredTryOnPhotos()
    .then(loadTryOnPhotoForSession)
    .then(savedPhoto => {
      if (!savedPhoto?.blob) return;
      if (savedPhoto.expiresAt <= Date.now()) {
        return removeTryOnPhotoForSession();
      }
      const file = new File([savedPhoto.blob], savedPhoto.name || "foto-de-inicio", {
        type: savedPhoto.type || savedPhoto.blob.type || "image/jpeg",
        lastModified: savedPhoto.lastModified || Date.now(),
      });
      showSelectedPhoto(file, false, false);
    })
    .catch(error => {
      console.error("No se pudo recuperar la foto para el Probador.", error);
    });
  restoreRememberedPhoto();
  window.addEventListener("pagehide", stopCamera);
})();
