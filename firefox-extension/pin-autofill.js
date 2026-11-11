(() => {
  let filling = false;
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
  // The Ozon PIN screen identifies its four boxes through this nearby prompt.
  function findOzonPinFields() {
    const labels = Array.from(document.querySelectorAll("body *"))
      .filter(el => el.children.length === 0 &&
        /введите\s+код-пароль\s+для\s+входа/i.test(el.textContent || ""));
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
    if (filling) return;
    const { ozonPin } = await browser.storage.local.get("ozonPin");
    if (!PIN_RE.test(ozonPin || "")) return;
    const fields = findOzonPinFields() || findFallbackFields();
    if (!fields?.length) return;
    filling = true;
    try {
      if (fields.length === 4) {
        fields.forEach((el, i) => setValue(el, ozonPin[i]));
        fields[0].focus();
      } else {
        setValue(fields[0], ozonPin);
        fields[0].focus();
      }
    } finally { filling = false; }
  }
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      tryFill().catch(error => console.debug("Ozon PIN autofill:", error));
    }, 250);
  };
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