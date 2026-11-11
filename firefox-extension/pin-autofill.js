(() => {
  let filling = false;
  const visible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const candidates = () => Array.from(document.querySelectorAll("input"))
    .filter(el => visible(el) && !el.disabled && !el.readOnly &&
      (el.maxLength === 1 || el.getAttribute("inputmode") === "numeric" ||
       /^(tel|number|password)$/i.test(el.type)) &&
      !/search|email/i.test(el.type));
  function setValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  async function tryFill() {
    if (filling) return;
    const { ozonPin } = await browser.storage.local.get("ozonPin");
    if (!/^\d{4}$/.test(ozonPin || "")) return;
    const fields = candidates();
    // Only target a clearly segmented four-character PIN control.
    const segmented = fields.filter(el => el.maxLength === 1);
    if (segmented.length !== 4 || segmented.some(el => el.value)) return;
    filling = true;
    try {
      segmented.forEach((el, i) => setValue(el, ozonPin[i]));
      segmented[0].focus();
    } finally {
      filling = false;
    }
  }
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; tryFill().catch(() => {}); }, 250);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.ozonPin) schedule();
  });
  schedule();
})();