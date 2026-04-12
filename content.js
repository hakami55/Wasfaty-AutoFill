(() => {
  "use strict";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);

  function isVisible(el) {
    if (!el) return false;
    const st = getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0";
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
  }

  function keyMeta(ch) {
    // يطلع keyCode/code مناسب للحروف والأرقام (مهم لـ e11)
    if (/^[a-z]$/i.test(ch)) {
      const upper = ch.toUpperCase();
      return { key: ch, code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
    }
    if (/^[0-9]$/.test(ch)) {
      return { key: ch, code: `Digit${ch}`, keyCode: 48 + Number(ch) };
    }
    return { key: ch, code: "", keyCode: 0 };
  }

  function fireKey(el, type, meta) {
    const evt = new KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      key: meta.key,
      code: meta.code,
      keyCode: meta.keyCode,
      which: meta.keyCode
    });
    el.dispatchEvent(evt);
  }

  async function typeHumanStrict(input, text, delay = 120) {
    input.focus();
    // نظّف
    setNativeValue(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(80);

    for (const ch of text) {
      const meta = keyMeta(ch);

      fireKey(input, "keydown", meta);
      fireKey(input, "keypress", meta);

      // حدّث القيمة تدريجيًا
      setNativeValue(input, (input.value || "") + ch);

      // input event (يُشبه اليدوي أكثر)
      try {
        input.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            data: ch,
            inputType: "insertText"
          })
        );
      } catch {
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }

      fireKey(input, "keyup", meta);
      await sleep(delay);
    }
  }

  function findSelectDrugClickable() {
    // أفضل: خذ الـ container الخاص بقسم Drugs ثم ابحث داخلها عن Select Drug
    const drugsSection =
      [...document.querySelectorAll("div")].find(d => (d.textContent || "").includes("Drug Generic Name")) ||
      document;

    const nodes = [...drugsSection.querySelectorAll("*")].filter((n) => (n.textContent || "").trim() === "Select Drug");
    for (const n of nodes) {
      const clickable =
        n.closest('button, [role="button"], [role="combobox"], .p-dropdown, .ng-select, div') || n;
      if (clickable) return clickable;
    }
    return null;
  }

  function findFilterInput() {
    const el =
      $('input[placeholder="Filter the options"]') ||
      $('input[placeholder*="Filter" i]') ||
      $('input[type="search"]');
    return el && isVisible(el) ? el : null;
  }

  function findNoResultsNode() {
    // يبحث عن رسالة no results إن وجدت
    const all = [...document.querySelectorAll("*")];
    return all.find(n => (n.textContent || "").includes("Sorry, but no results found"));
  }

  function findFirstOption() {
    return (
      document.querySelector('.p-dropdown-items .p-dropdown-item:not(.p-disabled)') ||
      document.querySelector('[role="listbox"] [role="option"]') ||
      document.querySelector("li[role='option']") ||
      document.querySelector(".select2-results__option") ||
      null
    );
  }

  async function waitForResults(timeoutMs = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const opt = findFirstOption();
      const noRes = findNoResultsNode();
      if (opt && isVisible(opt)) return { ok: true, opt };
      if (noRes) return { ok: false, reason: "no_results" };
      await sleep(150);
    }
    return { ok: false, reason: "timeout" };
  }

  function detectFormType() {

  if (document.querySelector('textarea[name="Instructions"]')) {
      return "special";
  }

  if (document.querySelector('[name="FrequencyValue"]')) {
      return "normal";
  }

  return "unknown";
}

  async function fillDrugFlow(raw) {
    const drugName = (raw || "").trim(); // مهم: يمنع مسافات خفية
    if (!drugName) return { ok: false, error: "⚠️ قيمة فاضية" };

    const select = findSelectDrugClickable();
    if (!select) return { ok: false, error: "❌ لم أجد خانة Select Drug" };

    select.click();
    await sleep(450);

    let filterInput = null;
    for (let i = 0; i < 25; i++) {
      filterInput = findFilterInput();
      if (filterInput) break;
      await sleep(120);
    }
    if (!filterInput) return { ok: false, error: "❌ لم يظهر مربع Filter the options" };

    // اكتب مثل اليدوي (أبطأ شوي لضمان نتائج E11)
    await typeHumanStrict(filterInput, drugName, 140);

    // انتظر النتائج بدل ما نختار بسرعة
    const res = await waitForResults(5000);

    if (!res.ok && res.reason === "no_results") {
      // جرّب مرة ثانية بحروف كبيرة فقط للحرف (E11) كحل إضافي
      if (/^[a-z]\d\d$/i.test(drugName)) {
        setNativeValue(filterInput, "");
        filterInput.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(200);
        await typeHumanStrict(filterInput, drugName.toUpperCase(), 160);
        const res2 = await waitForResults(5000);
        if (res2.ok) {
          res2.opt.click();
          return { ok: true };
        }
      }
      return { ok: false, error: "❌ ظهرت رسالة: Sorry, but no results found" };
    }

    if (!res.ok) return { ok: false, error: "❌ النتائج تأخرت أو لم تظهر" };

    // اختر أول خيار
    res.opt.click();
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "FILL_DRUG") return;

    fillDrugFlow(msg.drug)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e?.message || "Unknown error" }));

    return true;
  });
})();
