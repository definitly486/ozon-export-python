const LOCAL_API = "http://127.0.0.1:8765/api/psb/auto-sync";
const NOTIFICATION_ID = "ozon-bill-psb-sync";

async function notify(title, message, badge = "!") {
  try {
    await browser.action.setBadgeBackgroundColor({
      color: badge === "OK" ? "#16803c" : badge === "..." ? "#2563eb" : "#b42318"
    });
    await browser.action.setBadgeText({ text: badge });
    await browser.action.setTitle({ title: title + " — " + message });
  } catch (error) {
    console.error("Не удалось обновить индикатор ПСБ:", error);
  }
  try {
    await browser.notifications.create(NOTIFICATION_ID, {
      type: "basic",
      iconUrl: browser.runtime.getURL("icon.svg"),
      title,
      message
    });
  } catch (error) {
    console.error("Не удалось показать уведомление ПСБ:", error);
  }
}

// Runs in the authenticated PSB page's MAIN world. It clicks the bank's own
// export controls and captures the CSV response/blob without reading cookies.
async function clickAndCapturePsbCsv() {
  const normalize = value => String(value || "").replace(/\\s+/g, " ").trim();
  const visible = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const findExact = label => {
    const candidates = [...document.querySelectorAll("button,a,[role='button'],[tabindex],div,span")]
      .filter(element => visible(element) && normalize(element.innerText || element.textContent) === label);
    candidates.sort((a, b) => {
      const score = element => (element.matches("button,a,[role='button']") ? 0 : 1) + (element.querySelector("*") ? 1 : 0);
      return score(a) - score(b);
    });
    return candidates[0] || null;
  };
  const clickElement = element => (element.closest("button,a,[role='button']") || element).click();
  const isCsv = value => typeof value === "string" &&
    value.includes("Дата и время транзакции") &&
    value.includes("Сумма в валюте карты");

  let resolveCsv, rejectCsv;
  const captured = new Promise((resolve, reject) => { resolveCsv = resolve; rejectCsv = reject; });
  let settled = false;
  const finish = (error, csv) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) rejectCsv(error); else resolveCsv(csv);
  };
  const timer = setTimeout(() => finish(new Error(
    "Не удалось перехватить CSV. Возможно, ПСБ изменил способ скачивания выписки."
  )), 25000);

  const originalCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function(object) {
    try {
      if (object instanceof Blob) {
        object.text().then(text => { if (isCsv(text)) finish(null, text); }).catch(() => {});
      }
    } catch (_) {}
    return originalCreate(object);
  };

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function(...args) {
    const response = await originalFetch(...args);
    try {
      const clone = response.clone();
      const contentType = clone.headers.get("content-type") || "";
      if (/csv|text|octet-stream/i.test(contentType)) {
        clone.text().then(text => { if (isCsv(text)) finish(null, text); }).catch(() => {});
      } else {
        clone.text().then(text => { if (isCsv(text)) finish(null, text); }).catch(() => {});
      }
    } catch (_) {}
    return response;
  };

  try {
    let download = findExact("Скачать в CSV");
    if (!download) {
      const openMenu = findExact("Получить выписку");
      if (!openMenu) throw new Error("Не найдена кнопка «Получить выписку». Откройте страницу выписки ПСБ.");
      clickElement(openMenu);
      await new Promise(resolve => setTimeout(resolve, 400));
      download = findExact("Скачать в CSV");
    }
    if (!download) throw new Error("Меню выписки не открылось или пункт «Скачать в CSV» не найден.");
    clickElement(download);
    return await captured;
  } finally {
    URL.createObjectURL = originalCreate;
    window.fetch = originalFetch;
  }
}

browser.action.onClicked.addListener(async tab => {
  try {
    await notify("Ozon Bill — ПСБ", "Проверяю открытую страницу выписки…", "...");
    if (!tab || !tab.id || !tab.url || !tab.url.startsWith("https://ib.psbank.ru/")) {
      throw new Error("Откройте в Firefox страницу выписки ПСБ, выберите период и нажмите значок расширения.");
    }
    let injected;
    try {
      injected = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: clickAndCapturePsbCsv
      });
    } catch (error) {
      throw new Error("Не удалось запустить экспорт на странице ПСБ. Обновите вкладку и проверьте разрешения расширения. " + (error.message || error));
    }
    const csv = injected && injected[0] && injected[0].result;
    if (typeof csv !== "string" || !csv.includes("Дата и время транзакции")) {
      throw new Error("ПСБ не передал CSV-выписку. Попробуйте повторить экспорт или сообщите об ошибке разработчику.");
    }

    await notify("Ozon Bill — ПСБ", "CSV получен (" + csv.length + " символов). Передаю выписку в локальную базу…", "...");
    let health;
    try {
      health = await fetch("http://127.0.0.1:8765/api/health", { cache: "no-store" });
      if (!health.ok) throw new Error("HTTP " + health.status);
    } catch (error) {
      throw new Error("Локальное приложение недоступно. Запустите ./run.sh. " + (error.message || error));
    }

    const response = await fetch(LOCAL_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv }),
      cache: "no-store"
    });
    let result;
    try { result = await response.json(); }
    catch (_) { throw new Error("Локальное приложение вернуло некорректный ответ."); }
    if (!response.ok || result.ok !== true) throw new Error(result.error || "Импорт ПСБ отклонён.");

    const sync = result.sync || {};
    const added = Number(sync.new || 0);
    const updated = Number(sync.updated || 0);
    const unchanged = Number(sync.unchanged || 0);
    const total = Number(result.database_total || 0);
    await notify("Ozon Bill — ПСБ успешно", "Операций в выписке: " + Number(result.imported || 0) +
      "\nДобавлено: " + added + " · Обновлено: " + updated +
      "\nБез изменений: " + unchanged + "\nВсего в базе ПСБ: " + total, "OK");
  } catch (error) {
    await notify("Ozon Bill — ошибка ПСБ", String(error.message || error).slice(0, 450), "!");
    console.error("PSB import failed:", error);
  }
});