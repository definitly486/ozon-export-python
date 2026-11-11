const OZON_API = "https://finance.ozon.ru/apps/pfm/api/operations/groupOperationsV3";
const LOCAL_API = "http://127.0.0.1:8765/api/ozon/auto-sync";

async function collectOzonOperations() {
  let cursor = null;
  const items = [];
  let page = 0;
  do {
    const response = await fetch(OZON_API, {
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
    if (!response.ok) throw new Error("Ozon ответил HTTP " + response.status);
    const json = await response.json();
    const group = json?.data?.me?.client?.groupOperationsV3;
    if (!group || !Array.isArray(group.items)) throw new Error("Ozon вернул неизвестный формат операций");
    items.push(...group.items);
    cursor = group.cursors?.next ?? null;
    page += 1;
    if (page >= 500) break;
  } while (cursor);
  return { items };
}

browser.action.onClicked.addListener(async tab => {
  try {
    const url = new URL(tab.url || "");
    if (url.hostname !== "finance.ozon.ru") {
      await browser.notifications.create({
        type: "basic", iconUrl: "icon.svg", title: "Ozon Bill",
        message: "Сначала откройте finance.ozon.ru и войдите в аккаунт."
      });
      return;
    }
    const injected = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: collectOzonOperations
    });
    const payload = injected?.[0]?.result;
    if (!payload || !Array.isArray(payload.items)) throw new Error("Не удалось получить список операций из вкладки Ozon");

    const response = await fetch(LOCAL_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Локальное приложение отклонило импорт");

    await browser.notifications.create({
      type: "basic", iconUrl: "icon.svg", title: "Ozon Bill — обновлено",
      message: result.message || ("Получено операций: " + payload.items.length)
    });
  } catch (error) {
    await browser.notifications.create({
      type: "basic", iconUrl: "icon.svg", title: "Ozon Bill — ошибка",
      message: String(error.message || error).slice(0, 180)
    });
  }
});
