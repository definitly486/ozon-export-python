const pin = document.getElementById("pin");
const status = document.getElementById("status");
const eventsList = document.getElementById("events");
const eventNames = {
  "ozon-content-script-loaded": "Скрипт расширения запущен на странице Ozon",
  "ozon-pin-screen-detected": "Обнаружен экран запроса PIN",
  "ozon-pin-not-configured": "PIN не сохранён или имеет неверный формат",
  "ozon-pin-fields-not-found": "Экран PIN найден, но поля ввода не распознаны",
  "ozon-pin-autofilled": "PIN подставлен в поля",
  "ozon-pin-script-error": "Ошибка скрипта автозаполнения",
  "import-started": "Начат импорт операций",
  "import-ozon-opened": "Открыта фоновая вкладка Ozon",
  "import-ozon-loaded": "Страница Ozon загружена",
  "import-data-received": "Операции получены от Ozon",
  "import-saving": "Сохранение операций в локальную базу",
  "import-success": "Импорт завершён успешно",
  "import-error": "Ошибка импорта"
};
function renderEvents(events) {
  eventsList.replaceChildren();
  if (!events?.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Событий пока нет. Нажмите значок расширения, чтобы начать импорт.";
    eventsList.append(empty);
    return;
  }
  for (const event of [...events].reverse()) {
    const item = document.createElement("li");
    const time = document.createElement("span");
    time.className = "event-time";
    time.textContent = new Date(event.time).toLocaleString();
    const title = document.createElement("strong");
    title.textContent = eventNames[event.type] || event.type || "Событие";
    item.append(time, title);
    const detailText = [event.host, event.detail].filter(Boolean).join(" — ");
    if (detailText) {
      const detail = document.createElement("span");
      detail.className = "event-detail";
      detail.textContent = detailText;
      item.append(detail);
    }
    eventsList.append(item);
  }
}
async function loadEvents() {
  const { ozonDiagnosticLog = [] } = await browser.storage.local.get("ozonDiagnosticLog");
  renderEvents(ozonDiagnosticLog);
}
browser.storage.local.get("ozonPin").then(({ozonPin}) => {
  if (/^\d{4}$/.test(ozonPin || "")) status.textContent = "PIN уже сохранён. Для замены введите новый код.";
});
document.getElementById("save").addEventListener("click", async () => {
  const value = pin.value.trim();
  if (!/^\d{4}$/.test(value)) {
    status.textContent = "Введите ровно четыре цифры.";
    return;
  }
  await browser.storage.local.set({ozonPin: value});
  pin.value = "";
  status.textContent = "PIN сохранён в профиле Firefox.";
});
document.getElementById("clear-log").addEventListener("click", async () => {
  await browser.storage.local.set({ozonDiagnosticLog: []});
  renderEvents([]);
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.ozonDiagnosticLog) renderEvents(changes.ozonDiagnosticLog.newValue || []);
});
loadEvents().catch(error => {
  eventsList.textContent = "Не удалось прочитать журнал: " + (error.message || error);
});