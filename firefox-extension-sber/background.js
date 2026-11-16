const LOCAL_HEALTH = "http://127.0.0.1:8765/api/health";
const LOCAL_IMPORT = "http://127.0.0.1:8765/api/sber/import?start=2000-01-01&end=2099-12-31";
const NOTIFICATION_ID = "ozon-bill-sber-sync";
let running = false;

async function notify(title, message, badge = "...") {
  try {
    await browser.action.setBadgeBackgroundColor({
      color: badge === "OK" ? "#16803c" : badge === "!" ? "#b42318" : "#2563eb"
    });
    await browser.action.setBadgeText({ text: badge });
    await browser.action.setTitle({ title: title + " — " + message });
  } catch (_) {}
  try {
    await browser.notifications.create(NOTIFICATION_ID, {
      type: "basic",
      iconUrl: browser.runtime.getURL("icon.svg"),
      title,
      message: String(message).slice(0, 450)
    });
  } catch (_) {}
}

function isSberTab(tab) {
  if (!tab || !tab.url) return false;
  try {
    const url = new URL(tab.url);
    return url.protocol === "https:" &&
      (url.hostname === "online.sberbank.ru" ||
       url.hostname.endsWith(".sberbank.ru") ||
       url.hostname.endsWith(".sber.ru"));
  } catch (_) {
    return false;
  }
}

// Runs in the bank page's MAIN world. It captures only a PDF explicitly
// requested by the user through the bank's own statement/download interface.
// It never reads form values, PINs, passwords, cookies, localStorage or tokens.
async function captureSberPdf() {
  const visible = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== "hidden" && style.display !== "none";
  };
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase("ru-RU");
  const visiblePassword = [...document.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"]')]
    .some(visible);

  if (visiblePassword || /login|auth|signin|pin/i.test(location.pathname)) {
    throw new Error("Сбербанк ещё не авторизован. Введите PIN-код или выполните вход непосредственно на официальной странице банка, дождитесь открытия личного кабинета и снова нажмите значок расширения.");
  }

  const isPdf = bytes => {
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 100) return false;
    const head = new Uint8Array(bytes, 0, Math.min(1024, bytes.byteLength));
    const signature = new TextDecoder("latin1").decode(head);
    return signature.includes("%PDF-");
  };
  let resolvePdf;
  let rejectPdf;
  const captured = new Promise((resolve, reject) => {
    resolvePdf = resolve;
    rejectPdf = reject;
  });
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    error ? rejectPdf(error) : resolvePdf(value);
  };
  const inspectBuffer = buffer => {
    try {
      if (isPdf(buffer)) finish(null, buffer);
    } catch (_) {}
  };
  const inspectBlob = blob => {
    if (blob instanceof Blob && (blob.type === "application/pdf" || blob.size > 100)) {
      blob.arrayBuffer().then(inspectBuffer).catch(() => {});
    }
  };
  const timer = setTimeout(() => finish(new Error(
    "PDF не перехвачен. Откройте в СберБанк Онлайн историю нужной карты или счёта, выберите выписку и повторите импорт на странице, где доступно скачивание PDF."
  )), 35000);

  const originalCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function(object) {
    try { inspectBlob(object); } catch (_) {}
    return originalCreate(object);
  };

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function(...args) {
    const response = await originalFetch(...args);
    try {
      response.clone().arrayBuffer().then(inspectBuffer).catch(() => {});
    } catch (_) {}
    return response;
  };

  const XHR = window.XMLHttpRequest;
  const originalOpen = XHR.prototype.open;
  XHR.prototype.open = function(...args) {
    this.addEventListener("load", () => {
      try {
        if (this.response instanceof Blob) inspectBlob(this.response);
        else if (this.response instanceof ArrayBuffer) inspectBuffer(this.response);
      } catch (_) {}
    });
    return originalOpen.apply(this, args);
  };

  const candidates = [...document.querySelectorAll("a[href],button,[role='button']")]
    .filter(visible)
    .map(element => ({
      element,
      label: normalize(element.innerText || element.textContent || element.getAttribute("aria-label")),
      href: element.href || ""
    }));

  // If a PDF link is already present, fetch that exact bank-provided URL
  // using the current authenticated page context.
  const pdfLink = candidates.find(item =>
    item.href && /\.pdf(?:[?#]|$)/i.test(item.href)
  );
  if (pdfLink) {
    fetch(pdfLink.href, { credentials: "include", cache: "no-store" })
      .then(response => {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.arrayBuffer();
      })
      .then(inspectBuffer)
      .catch(() => {});
  }

  // Click only unambiguous PDF/statement download controls. Do not click
  // generic action buttons that could initiate a transfer or payment.
  const exactLabels = new Set([
    "скачать pdf",
    "pdf",
    "скачать выписку pdf",
    "скачать выписку",
    "сохранить pdf",
    "экспорт в pdf",
    "скачать отчет pdf",
    "скачать отчёт pdf"
  ]);
  const button = candidates.find(item => exactLabels.has(item.label));
  if (button) {
    const anchor = button.element.matches("a[href]") ? button.element :
      button.element.closest("a[href]");
    if (anchor && anchor.href) {
      fetch(anchor.href, { credentials: "include", cache: "no-store" })
        .then(response => response.ok ? response.arrayBuffer() : Promise.reject(new Error("HTTP " + response.status)))
        .then(inspectBuffer)
        .catch(() => {});
    }
    button.element.click();
  }

  try {
    return await captured;
  } finally {
    URL.createObjectURL = originalCreate;
    window.fetch = originalFetch;
    XHR.prototype.open = originalOpen;
  }
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function importSber() {
  if (running) return;
  running = true;
  try {
    await notify("Сбербанк — импорт", "Проверяю локальное приложение…");
    let health;
    try {
      health = await fetch(LOCAL_HEALTH, { cache: "no-store" });
      if (!health.ok) throw new Error("HTTP " + health.status);
    } catch (error) {
      throw new Error("Локальный Ozon Bill недоступен. Запустите ./run.sh. " + (error.message || error));
    }

    const tabs = await browser.tabs.query({});
    const bankTab = tabs.find(isSberTab);
    if (!bankTab) {
      throw new Error("Не найдена вкладка СберБанк Онлайн. Откройте https://online.sberbank.ru в Firefox, войдите в банк и оставьте вкладку открытой.");
    }

    await notify("Сбербанк — ожидаю PDF", "Если банк запросит PIN, введите его на официальной странице. Для импорта откройте выписку по карте/счёту и нажмите значок расширения на странице скачивания.");
    const result = await browser.scripting.executeScript({
      target: { tabId: bankTab.id },
      world: "MAIN",
      func: captureSberPdf
    });
    const pdf = result && result[0] ? result[0].result : null;
    if (!(pdf instanceof ArrayBuffer) && !(pdf && pdf.type === "arraybuffer")) {
      throw new Error("Не удалось получить PDF из вкладки Сбербанка. Перейдите к истории операций нужной карты/счёта и откройте экран, где доступно скачивание выписки в PDF.");
    }

    const buffer = pdf instanceof ArrayBuffer ? pdf : pdf;
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: "application/pdf" }), "sber_statement.pdf");
    const response = await fetch(LOCAL_IMPORT, {
      method: "POST",
      body: form,
      cache: "no-store"
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      throw new Error(payload.error || "Локальное приложение не смогло импортировать PDF.");
    }

    const sync = payload.sync || {};
    await notify("Сбербанк — импорт завершён",
      "Добавлено: " + (sync.new || 0) +
      " · Обновлено: " + (sync.updated || 0) +
      " · Без изменений: " + (sync.unchanged || 0) +
      " · Всего в базе: " + ((payload.sber && payload.sber.database_total) || 0), "OK");
  } catch (error) {
    await notify("Сбербанк — ошибка импорта", error.message || String(error), "!");
    console.error("Sberbank import failed:", error);
  } finally {
    running = false;
  }
}

browser.action.onClicked.addListener(importSber);
