const LOCAL_API = "http://127.0.0.1:8765/api/ozon/auto-sync";
const NOTIFICATION_ID = "ozon-bill-sync";

// Content script reports PIN autofill from the temporary Ozon tab.
// Show this in Firefox notifications so it remains visible after redirects.
browser.runtime.onMessage.addListener(message => {
  switch (message?.type) {
    case "ozon-content-script-loaded":
      return notify("Ozon — скрипт расширения запущен",
        "Автоскрипт работает на странице " + (message.host || "Ozon") + ".", "...");
    case "ozon-pin-script-error":
      return notify("Ozon — ошибка скрипта PIN",
        String(message.error || "Неизвестная ошибка").slice(0, 300), "!");

    case "ozon-pin-screen-detected":
      return notify("Ozon — обнаружен экран PIN",
        "Страница запроса PIN найдена. Проверяю сохранённый код и поля ввода…", "...");
    case "ozon-pin-not-configured":
      return notify("Ozon — PIN не сохранён",
        "Откройте настройки расширения и сохраните четырёхзначный PIN.", "!");
    case "ozon-pin-fields-not-found":
      return notify("Ozon — поля PIN не найдены",
        "Экран PIN обнаружен, но поля ввода не распознаны. Автозаполнение не выполнено.", "!");
    case "ozon-pin-autofilled": {
      const count = Number(message.fieldCount) === 4 ? "четыре поля" : "поле";
      return notify("Ozon — PIN подставлен",
        "Сохранённый PIN автоматически введён в " + count + ". Вход не подтверждается автоматически.", "OK");
    }
    default:
      return;
  }
});

async function notify(title, message, badge = "!", eventType = null) {
  // Keep a durable diagnostic history in extension storage. This remains
  // available in the options page after temporary Ozon tabs are closed.
  try {
    const { ozonDiagnosticLog = [] } = await browser.storage.local.get("ozonDiagnosticLog");
    const inferredType = eventType || (
      title.includes("успешно") ? "import-success" :
      title.includes("ошибка") ? "import-error" :
      title.includes("сохранение") ? "import-saving" :
      title.includes("импорт") ? "import-started" : title
    );
    const entry = {
      type: inferredType,
      time: new Date().toISOString(),
      detail: String(message || "").slice(0, 500)
    };
    await browser.storage.local.set({ ozonDiagnosticLog: [...ozonDiagnosticLog, entry].slice(-100) });
  } catch (error) {
    console.error("Не удалось сохранить журнал Ozon:", error);
  }
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

async function waitForFinanceReturn(tabId, timeoutMs = 180000) {
  const isFinance = url => {
    try { return new URL(url).hostname === "finance.ozon.ru"; }
    catch (_) { return false; }
  };
  const isOzonDomain = url => {
    try {
      const host = new URL(url).hostname;
      return host === "ozon.ru" || host.endsWith(".ozon.ru");
    } catch (_) { return false; }
  };
  const describeUrl = url => url || "URL пока недоступен (ожидаю завершения навигации)";
  const initial = await browser.tabs.get(tabId).catch(() => null);
  if (initial?.url && isFinance(initial.url)) return;
  if (initial?.url && !isOzonDomain(initial.url)) {
    throw new Error("Ozon открыл неожиданный адрес: " + initial.url +
      ". Разрешите расширению доступ к страницам ozon.ru и повторите импорт.");
  }

  await notify("Ozon — требуется авторизация",
    "Импорт выполняется в фоне. Если сессия истекла, войдите в Ozon вручную в обычной вкладке и повторите импорт.", "...");
  // Quiet mode: keep the temporary Ozon tab in the background.
  // If interactive login is required, do not steal focus; report that the user
  // must sign in to Ozon manually and retry the import.


  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error); else resolve();
    };
    const inspect = url => {
      if (!url) return; // Firefox may omit tab.url until host permission is granted.
      if (isFinance(url)) finish();
      else if (!isOzonDomain(url)) {
        finish(new Error("После входа Ozon открыл неожиданный адрес: " + url +
          ". Проверьте, что вход выполняется в официальном домене Ozon."));
      }
    };
    const onUpdated = (updatedId, changeInfo, updatedTab) => {
      if (updatedId !== tabId) return;
      inspect(changeInfo?.url || updatedTab?.url);
    };
    const timer = setTimeout(() =>
      finish(new Error("Не дождался возврата в Ozon Банк за 3 минуты. Проверьте вход и повторите импорт.")),
      timeoutMs
    );

    // Subscribe before re-reading the tab to avoid missing a fast redirect.
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.get(tabId).then(tab => inspect(tab?.url)).catch(() => {});
  });
}

async function getOperationsFromBackgroundTab() {
  const tab = await browser.tabs.create({
    url: "https://finance.ozon.ru/lk",
    active: false
  });
  try {
    await waitForTabComplete(tab.id);
    await notify("Ozon — страница загружена",
      "Фоновая вкладка загружена. Проверяю адрес и состояние авторизации…", "...", "import-ozon-loaded");
    await waitForFinanceReturn(tab.id);
    const current = await browser.tabs.get(tab.id);
    if (!current.url || new URL(current.url).hostname !== "finance.ozon.ru") {
      throw new Error("Ожидался finance.ozon.ru, но текущий адрес: " + (current.url || "неизвестен"));
    }

    await notify("Ozon — запрашиваю операции",
      "Страница банка открыта. Выполняю запрос списка операций…", "...", "import-api-request");
    let injected;
    try {
      injected = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: collectOzonOperations
      });
    } catch (error) {
      throw new Error("Firefox не смог выполнить запрос на странице Ozon: " +
        String(error?.message || error));
    }

    const first = Array.isArray(injected) ? injected[0] : null;
    const payload = first?.result;
    if (!first) {
      throw new Error("Firefox не вернул результат выполнения скрипта. Адрес: " + current.url);
    }
    if (first.error) {
      throw new Error("Ошибка выполнения запроса Ozon: " +
        String(first.error.message || first.error));
    }
    if (!payload || !Array.isArray(payload.items)) {
      const resultType = payload === null ? "null" : typeof payload;
      const resultKeys = payload && typeof payload === "object"
        ? Object.keys(payload).join(", ") : "нет";
      throw new Error("Ответ скрипта Ozon имеет неожиданный формат. Тип: " +
        resultType + "; поля: " + resultKeys +
        "; адрес: " + new URL(current.url).pathname +
        ". Возможно, страница банка ещё не авторизована или API изменился.");
    }
    await notify("Ozon — операции получены",
      "Ozon вернул " + payload.items.length + " операций.", "...", "import-data-received");
    return payload;
  } finally {
    await browser.tabs.remove(tab.id).catch(() => {});
  }
}

browser.action.onClicked.addListener(async () => {
  try {
    await notify("Ozon Bill — выполняется импорт", "Открываю Ozon в фоновой вкладке и получаю операции…", "...", "import-started");
    const payload = await getOperationsFromBackgroundTab();
    if (payload.items.length === 0) throw new Error("Ozon вернул пустой список операций. Возможно, требуется повторный вход в аккаунт.");

    await notify("Ozon Bill — сохраняю операции", "Получено из Ozon: " + payload.items.length + ". Записываю в локальную базу…", "...", "import-data-received");
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
