const pin = document.getElementById("pin");
const status = document.getElementById("status");
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
  status.textContent = "PIN сохранён в профиле Firefox. На странице Ozon он будет подставляться автоматически.";
});