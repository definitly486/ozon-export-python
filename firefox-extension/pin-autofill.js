(() => {
  let filling = false;
  const PIN_RE = /^\d{4}$/;
  const visible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 &&
      s.visibility !== "hidden" && s.display !== "none";
  };
  const hint = el => [
    el.name, el.id, el.placeholder, el.getAttribute("aria-label"),
    el.getAttribute("autocomplete"), el.getAttribute("data-testid"),
    el.getAttribute("inputmode"), el.getAttribute("pattern")
  ].filter(Boolean).join(" ").toLowerCase();

  const isNumeric = el =>
    el.getAttribute("inputmode") === "numeric" ||
    /^(tel|number)$/i.test(el.type) ||
    /\\d|0-9|numeric/i.test(el.getAttribute("pattern") || "");

  const inputs = () => Array.from(document.querySelectorAll("input"))
    .filter(el => visible(el) && !el.disabled && !el.readOnly &&
      !/search|email/i.test(el.type));

  function setValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, "value"
    )?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function findSegmented(fields) {
    const oneDigit = fields.filter(el =>
      el.maxLength === 1 && (isNumeric(el) || /pin|код|digit/i.test(hint(el)))
    );
    if (oneDigit.length !== 4 || oneDigit.some(el => el.value)) return null;
    return oneDigit;
  }

  function findSingle(fields) {
    return fields.find(el => {
      const label = hint(el);
      const pinNamed = /pin|пин|код доступа|код-пароль/.test(label);
      const fourDigits = el.maxLength === 4;
      const numericFour = fourDigits && (isNumeric(el) || /password/i.test(el.type));
      return !el.value && (pinNamed || numericFour) &&
        (el.maxLength === 4 || el.maxLength < 0);
    }) || null;
  }

  async function tryFill() {
    if (filling) return;
    const { ozonPin } = await browser.storage.local.get("ozonPin");
    if (!PIN_RE.test(ozonPin || "")) return;

    const fields = inputs();
    const segmented = findSegmented(fields);
    const single = segmented ? null : findSingle(fields);
    if (!segmented && !single) return;

    filling = true;
    try {
      if (segmented) {
        segmented.forEach((el, i) => setValue(el, ozonPin[i]));
        segmented[0].focus();
      } else {
        setValue(single, ozonPin);
        single.focus();
      }
    } finally {
      filling = false;
    }
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
  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true
    });
  }
  document.addEventListener("focusin", schedule, true);
  window.addEventListener("pageshow", schedule);
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.ozonPin) schedule();
  });
  schedule();
})();