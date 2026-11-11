const LOCAL_API = "http://127.0.0.1:8765/api/ozon/auto-sync";
const NOTIFICATION_ID = "ozon-bill-sync";

async function notify(title, message, badge = "!") {
  // Badge is visible on the extension icon even if desktop notifications are disabled.
  try {
    await browser.action.setBadgeBackgroundColor({ color: badge === "OK" ? "#16803c" : badge === "..." ? "#2563eb" : "#b42318" });
    await browser.action.setBadgeText({ text: badge });
    await browser.action.setTitle({ title: title + " — " + message });
  } catch (error) {
    console.error("Не удалось обновить индикатор расширения:", error);
  }

  // Firefox WebExtensions does not implement notifications.update().
  // Creating a notification with the same ID replaces the previous one.
  try {
    const options = { type: "basic", iconUrl: browser.runtime.getURL("icon.svg"), title, message };
    await browser.notifications.create(NOTIFICATION_ID, options);
  } catch (error) {
    console.error("Не удалось показать уведомление Firefox:", error);
  }
}

async function collectOzonOperations() {
  // This function is serialized and executed in the Ozon page context.
  // Keep all dependencies inside it: outer background constants are not available there.
  const ozonApi = "https://finance.ozon.ru/apps/pfm/api/operations/groupOperationsV3";
  let cursor = null;
  const items = [];
  let page = 0;
  do {
    let response;
    try {
      response = await fetch(ozonApi, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          cursorPagination: { cursor, perPage: 100 },
          filter: {
            categories: [], effect: "EFFECT_UNKNOWN", pfmTags: [],
            accountTokens: [], timeZone: "Europe/Moscow"
          }
        })
      });
    } catch (error) {
      throw new Error("Не удалось связаться с Ozon API из вкладки. Проверьте соединение, авторизацию и доступность finance.ozon.ru. Подробности: " + (error.message || error));
    }
    if (!response.ok) throw new Error("Ozon ответил HTTP " + response.status);
    const json = await response.json();
    const group = json?.data?.me?.client?.groupOperationsV3;
    if (!group || !Array.isArray(group.items)) throw new Error("Ozon вернул неизвестный формат операций");
    items.push(...group.items);
    cursor = group.cursors?.next ?? null;
    page += 1;
    if (page >= 500 && cursor) throw new Error("Слишком много страниц операций. Импорт остановлен, чтобы не сохранить неполную выписку.");
  } while (cursor);
  return { items };
}

async function waitForTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error);
      else resolve();
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const timer = setTimeout(() => finish(new Error("Ozon не загрузился за 45 секунд")), timeoutMs);
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.get(tabId).then(tab => {
      if (tab.status === "complete") finish();
    }).catch(finish);
  });
}

async function getOperationsFromBackgroundTab() {
  // Open a temporary inactive tab so the request runs in Ozon's authenticated
  // page context. The user does not need to keep the bank page open.
  const tab = await browser.tabs.create({
    url: "https://finance.ozon.ru/lk",
    active: false
  });
  try {
    await waitForTabComplete(tab.id);
    const current = await browser.tabs.get(tab.id);
    if (!current.url || new URL(current.url).hostname !== "finance.ozon.ru") {
      throw new Error("Ozon перенаправил на другой адрес. Возможно, требуется повторный вход в банк.");
    }
    const injected = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: collectOzonOperations
    });
    const payload = injected?.[0]?.result;
    if (!payload || !Array.isArray(payload.items)) {
      throw new Error("Не удалось получить операции. Проверьте, что сессия Ozon ещё действительна.");
    }
    return payload;
  } finally {
    await browser.tabs.remove(tab.id).catch(() => {});
  }
}

browser.action.onClicked.addListener(async () => {
  try {
    await notify("Ozon Bill — выполняется импорт", "Открываю Ozon в фоновой вкладке и получаю операции…", "...");
    const payload = await getOperationsFromBackgroundTab();
    if (payload.items.length === 0) throw new Error("Ozon вернул пустой список операций. Возможно, требуется повторный вход в аккаунт.");

    await notify("Ozon Bill — сохраняю операции", "Получено из Ozon: " + payload.items.length + ". Записываю в локальную базу…", "...");
    try {
      const health = await fetch("http://127.0.0.1:8765/api/health", { method: "GET", cache: "no-store" });
      if (!health.ok) throw new Error("HTTP " + health.status);
      const healthData = await health.json();
      if (healthData.ok !== true) throw new Error("неожиданный ответ сервера");
    } catch (error) {
      throw new Error("Ozon Bill недоступен на 127.0.0.1:8765. Запустите ./run.sh. Подробности: " + (error.message || error));
    }

    let response;
    try {
      response = await fetch(LOCAL_API, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(payload),
        cache: "no-store"
      });
    } catch (error) {
      throw new Error("Ozon Bill отвечает на проверку, но не принимает данные импорта. Подробности: " + (error.message || error));
    }
    let result;
    try {
      result = await response.json();
    } catch (_) {
      throw new Error("Локальное приложение вернуло некорректный ответ.");
    }
    if (!response.ok || result.ok !== true) throw new Error(result.error || "Локальное приложение отклонило импорт");

    const sync = result.sync || {};
    const added = Number(sync.new || 0);
    const updated = Number(sync.updated || 0);
    const unchanged = Number(sync.unchanged || 0);
    const skipped = Number(sync.skipped || 0);
    const total = Number(result.database_total || 0);
    const status = added + updated > 0
      ? "Импорт завершён успешно."
      : "Импорт завершён: новых изменений нет, данные уже актуальны.";
    const details = "Получено: " + payload.items.length +
      "\nДобавлено: " + added + " · Обновлено: " + updated +
      "\nБез изменений: " + unchanged +
      (skipped ? "\nПропущено: " + skipped : "") +
      "\nВсего в базе: " + total;
    await notify("Ozon Bill — успешно", status + "\n" + details, "OK");
  } catch (error) {
    await notify("Ozon Bill — ошибка импорта", String(error.message || error).slice(0, 450), "!");
    console.error("Ozon Bill import failed:", error);
  }
});
