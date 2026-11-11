const STATEMENT_URL = "https://ib.psbank.ru/lk/products/cards/account/2680291440/2517735140/about/statement";
const LOCAL_HEALTH = "http://127.0.0.1:8765/api/health";
const LOCAL_API = "http://127.0.0.1:8765/api/psb/auto-sync";
const NOTIFICATION_ID = "ozon-bill-psb-sync";
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

function waitForTab(tabId, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    const timer = setTimeout(() => finish(new Error("Страница ПСБ не загрузилась за 60 секунд.")), timeoutMs);
    browser.tabs.onUpdated.addListener(listener);
    browser.tabs.get(tabId).then(tab => {
      if (tab.status === "complete") finish();
    }).catch(finish);
  });
}

// Executed in the PSB page context before clicking the bank's CSV control.
// Captures CSV text from Blob URLs or Fetch/XHR responses; never reads cookies.
async function capturePsbCsv() {
  const normalize = value => String(value || "").replace(/\\s+/g, " ").trim();
  const isCsv = value => typeof value === "string" &&
    value.includes("Дата и время транзакции") &&
    value.includes("Сумма в валюте карты");
  const visible = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== "hidden" && style.display !== "none";
  };
  const findExact = label => {
    const nodes = [...document.querySelectorAll("button,a,[role='button'],[tabindex],div,span")]
      .filter(el => visible(el) && normalize(el.innerText || el.textContent) === label);
    nodes.sort((a, b) => {
      const score = el => (el.matches("button,a,[role='button']") ? 0 : 1) + (el.querySelector("*") ? 1 : 0);
      return score(a) - score(b);
    });
    return nodes[0] || null;
  };
  const click = el => (el.closest("button,a,[role='button']") || el).click();

  let resolveCsv;
  let rejectCsv;
  const captured = new Promise((resolve, reject) => {
    resolveCsv = resolve;
    rejectCsv = reject;
  });
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    error ? rejectCsv(error) : resolveCsv(value);
  };
  const inspectText = text => {
    if (isCsv(text)) finish(null, text);
  };
  const timer = setTimeout(() => finish(new Error(
    "Не удалось перехватить CSV из страницы ПСБ. Возможно, банк использует прямое скачивание файла."
  )), 25000);

  const originalCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function(object) {
    try {
      if (object instanceof Blob) object.text().then(inspectText).catch(() => {});
    } catch (_) {}
    return originalCreate(object);
  };

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function(...args) {
    const response = await originalFetch(...args);
    try { response.clone().text().then(inspectText).catch(() => {}); } catch (_) {}
    return response;
  };

  const XHR = window.XMLHttpRequest;
  const originalOpen = XHR.prototype.open;
  const originalSend = XHR.prototype.send;
  XHR.prototype.open = function(...args) {
    this.addEventListener("load", () => {
      try {
        if (typeof this.responseText === "string") inspectText(this.responseText);
      } catch (_) {}
    });
    return originalOpen.apply(this, args);
  };
  XHR.prototype.send = function(...args) {
    return originalSend.apply(this, args);
  };

  try {
    let item = findExact("Скачать в CSV");
    if (!item) {
      const menu = findExact("Получить выписку");
      if (!menu) throw new Error("Не найдена кнопка «Получить выписку». Проверьте выбранный период и доступ к выписке.");
      click(menu);
      await new Promise(resolve => setTimeout(resolve, 500));
      item = findExact("Скачать в CSV");
    }
    if (!item) throw new Error("Пункт «Скачать в CSV» не появился в меню ПСБ.");
    click(item);
    return await captured;
  } finally {
    URL.createObjectURL = originalCreate;
    window.fetch = originalFetch;
    XHR.prototype.open = originalOpen;
    XHR.prototype.send = originalSend;
  }
}

async function importPsb() {
  if (running) return;
  running = true;
  let tabId = null;
  try {
    await notify("ПСБ — импорт", "Открываю выписку в фоновой вкладке Firefox…");
    let health;
    try {
      health = await fetch(LOCAL_HEALTH, { cache: "no-store" });
      if (!health.ok) throw new Error("HTTP " + health.status);
    } catch (error) {
      throw new Error("Локальный Ozon Bill недоступен. Запустите ./run.sh. " + (error.message || error));
    }

    // active:false is intentional: the bank page is never brought to the foreground.
    const tab = await browser.tabs.create({ url: STATEMENT_URL, active: false });
    tabId = tab.id;
    await waitForTab(tabId);

    const current = await browser.tabs.get(tabId);
    if (!current.url || !current.url.startsWith("https://ib.psbank.ru/")) {
      throw new Error("Банк перенаправил на неизвестный адрес. Импорт остановлен.");
    }
    if (/\/login|\/auth|\/signin/i.test(new URL(current.url).pathname)) {
      throw new Error("Сессия ПСБ истекла или требуется подтверждение. Войдите в банк в обычной вкладке Firefox и повторите импорт.");
    }
    if (!current.url.includes("/about/statement")) {
      throw new Error("Не удалось открыть сохранённую страницу выписки. Проверьте доступ к счёту.");
    }

    await notify("ПСБ — получаю выписку", "Запускаю штатное скачивание CSV в фоновой вкладке…");
    const result = await browser.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: capturePsbCsv
    });
    const csv = result && result[0] && result[0].result;
    if (typeof csv !== "string" || !csv.includes("Дата и время транзакции")) {
      throw new Error("Страница ПСБ не вернула CSV-выписку.");
    }

    const response = await fetch(LOCAL_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv }),
      cache: "no-store"
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true) throw new Error(payload.error || "Локальное приложение отклонило выписку.");

    const sync = payload.sync || {};
    await notify("ПСБ — импорт завершён",
      "Добавлено: " + (sync.new || 0) +
      " · Обновлено: " + (sync.updated || 0) +
      " · Без изменений: " + (sync.unchanged || 0) +
      " · Всего в базе: " + (payload.database_total || 0), "OK");
  } catch (error) {
    await notify("ПСБ — ошибка импорта", error.message || String(error), "!");
    console.error("PSB import failed:", error);
  } finally {
    if (tabId !== null) await browser.tabs.remove(tabId).catch(() => {});
    running = false;
  }
}

browser.action.onClicked.addListener(importPsb);