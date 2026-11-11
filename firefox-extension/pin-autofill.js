(() => {
  let filling = false;
  let reportedScreen = false;
  let reportedMissingFields = false;
  let reportedMissingPin = false;
  const report = (type, extra = {}) =>
    browser.runtime.sendMessage({ type, host: location.hostname, ...extra }).catch(() => {});
  const PIN_RE = /^\d{4}$/;
  const visible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const editableInputs = root => Array.from(root.querySelectorAll("input"))
    .filter(el => visible(el) && !el.disabled && !el.readOnly &&
      !/hidden|search|email|checkbox|radio|submit|button/i.test(el.type));
  function setValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function pageText() {
    return document.body?.innerText || document.documentElement?.innerText || "";
  }
  function isPinScreen() {
    const text = pageText().toLowerCase();
    return (text.includes("код-пароль") || text.includes("код пароль") ||
      text.includes("код доступа")) &&
      (text.includes("вход") || text.includes("войти") || text.includes("ozon"));
  }
  function findOzonPinFields() {
    const labels = Array.from(document.querySelectorAll("body *"))
      .filter(el => el.children.length === 0 &&
        /(код-пароль|код пароль|код доступа)/i.test(el.textContent || ""));
    for (const label of labels) {
      let node = label;
      for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
        const fields = editableInputs(node);
        if (fields.length === 4 && fields.every(el => !el.value)) return fields;
        if (fields.length === 1 && !fields[0].value &&
            (fields[0].maxLength === 4 || fields[0].maxLength < 0)) return fields;
      }
    }
    return null;
  }
  function findFallbackFields() {
    const fields = editableInputs(document);
    const segmented = fields.filter(el => el.maxLength === 1);
    if (segmented.length === 4 && segmented.every(el => !el.value)) return segmented;
    const single = fields.find(el => !el.value &&
      (el.maxLength === 4 || el.maxLength < 0) &&
      /pin|пин|код|password|парол/i.test([
        el.name, el.id, el.placeholder, el.getAttribute("aria-label"),
        el.getAttribute("autocomplete"), el.getAttribute("data-testid")
      ].filter(Boolean).join(" ").toLowerCase()));
    return single ? [single] : null;
  }
  async function tryFill() {
    if (filling || !isPinScreen()) return;
    if (!reportedScreen) {
      reportedScreen = true;
      report("ozon-pin-screen-detected");
    }
    const { ozonPin } = await browser.storage.local.get("ozonPin");
    if (!PIN_RE.test(ozonPin || "")) {
      if (!reportedMissingPin) {
        reportedMissingPin = true;
        report("ozon-pin-not-configured");
      }
      return;
    }
    const fields = findOzonPinFields() || findFallbackFields();
    if (!fields?.length) {
      if (!reportedMissingFields) {
        reportedMissingFields = true;
        // PIN UI may live in another frame. Give sibling frames time to
        // autofill before reporting a page-wide failure.
        setTimeout(async () => {
          try {
            const { ozonPinAutofillAt = 0 } = await browser.storage.local.get("ozonPinAutofillAt");
            if (Date.now() - Number(ozonPinAutofillAt) < 15000) return;
            report("ozon-pin-fields-not-found", { frameUrl: location.href });
          } catch (_) {
            report("ozon-pin-fields-not-found", { frameUrl: location.href });
          }
        }, 2500);
      }
      return;
    }
    filling = true;
    try {
      if (fields.length === 4) {
        fields.forEach((el, i) => setValue(el, ozonPin[i]));
        fields[0].focus();
      } else {
        setValue(fields[0], ozonPin);
        fields[0].focus();
      }
      await browser.storage.local.set({ ozonPinAutofillAt: Date.now() });
      report("ozon-pin-autofilled", { fieldCount: fields.length, frameUrl: location.href });
    } finally { filling = false; }
  }
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      tryFill().catch(error => {
        console.error("Ozon PIN autofill:", error);
        report("ozon-pin-script-error", { error: String(error?.message || error) });
      });
    }, 250);
  };
  report("ozon-content-script-loaded", { frameUrl: location.href });
  const observer = new MutationObserver(schedule);
  if (document.documentElement) observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true
  });
  document.addEventListener("focusin", schedule, true);
  window.addEventListener("pageshow", schedule);
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.ozonPin) schedule();
  });
  schedule();
})();