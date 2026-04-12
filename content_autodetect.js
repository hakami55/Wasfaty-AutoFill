// Wasfaty Auto Detect Profile
// Watches selected drug and triggers AUTO_FILL automatically

(() => {
  const DEBUG = false;

  const log = (...a) => DEBUG && console.log("[AutoDetect]", ...a);

  function normalize(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function isVisible(el) {
    if (!el) return false;

    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;

    const r = el.getBoundingClientRect();
    return r.width > 5 && r.height > 5;
  }

  function extractCode(str) {
    const m = String(str || "").match(/Code:\s*([0-9-]+)/i);
    return m ? m[1].trim() : "";
  }

  function isUpdateMode() {
    const btn = [...document.querySelectorAll("button.btn.btn-primary.default-button, button.default-button")]
      .find((b) => {
        const t = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        return t === "add" || t === "update";
      });
    if (!btn) return false;
    const txt = (btn.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    return txt === "update";
  }

  async function isAutoDetectEnabled() {
    if (!globalThis.chrome?.storage?.local?.get) return true;
    return new Promise((resolve) => {
      chrome.storage.local.get(["wasfaty_auto_enabled"], (res) => {
        if (chrome.runtime?.lastError) {
          resolve(true);
          return;
        }
        const isEnabled = res?.wasfaty_auto_enabled ?? true;
        resolve(!!isEnabled);
      });
    });
  }

  function getDrugContainer() {
    const byState = document.querySelector('[data-stateportionname="DrugName"]');
    if (byState) return byState;

    const drugsHeader = [...document.querySelectorAll("*")]
      .find(e => (e.textContent || "").trim().startsWith("Drugs"));

    return drugsHeader ? (drugsHeader.closest("div") || document) : document;
  }

  function readDrugFromPage() {
    const container = getDrugContainer();

    const labels = [...container.querySelectorAll(".autocomplete-select-label, .auto-complete-select-label")]
      .filter(isVisible)
      .map(x => {
        const text = (x.textContent || "").trim();
        const title = (x.getAttribute("title") || "").trim();
        const code = extractCode(title) || extractCode(text);
        return { text, code };
      })
      .filter(x => x.text && !/^select\s+drug/i.test(x.text));

    if (labels.length) {
      // Use a snapshot of all selected rows so selecting Drug 2 also triggers.
      const snapshot = labels
        .map(x => x.code ? ("C:" + x.code) : ("T:" + x.text))
        .join("|");
      return snapshot;
    }

    const generic = [...container.querySelectorAll("span.generic-drug-text")]
      .filter(isVisible)
      .map(x => (x.textContent || "").trim())
      .filter(Boolean);

    if (generic.length) return "T:" + generic[0];

    const bold = [...container.querySelectorAll("b")]
      .filter(isVisible)
      .map(x => (x.textContent || "").trim())
      .filter(t => t && !/^drug/i.test(t) && t.length > 4);

    if (bold.length) return "T:" + bold[0];

    return "";
  }

  let lastDrugKey = "";
  let cooldown = false;
  let timer = null;

  async function triggerAutoFill(reason) {
    if (!globalThis.chrome?.runtime?.sendMessage) return;
    const enabled = await isAutoDetectEnabled();
    if (!enabled) {
      log("AutoDetect OFF");
      return;
    }

    if (isUpdateMode()) {
      log("Skip AUTO_FILL: form in Update mode");
      return;
    }

    if (cooldown) return;
    cooldown = true;

    setTimeout(() => {
      cooldown = false;
    }, 1500);

    log("Trigger AUTO_FILL:", reason);

    chrome.runtime.sendMessage({ type: "AUTO_FILL" }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) {
        log("AUTO_FILL error:", err.message);
        return;
      }

      if (!res?.ok) {
        log("AUTO_FILL failed:", res?.error);
        return;
      }

      if (res?.skipped && (res?.reason === "tab_busy" || res?.reason === "tab_busy_timeout")) {
        // Keep trying for the same drug when prior fill is still in progress (common on slower speeds).
        setTimeout(() => {
          cooldown = false;
          lastDrugKey = "";
          scheduleCheck("retry-busy");
        }, 700);
        return;
      }

      log("AUTO_FILL success:", res?.profile_used?.name || "", res?.reason || "");
    });
  }

  function checkNow(reason = "poll") {
    const drugKey = normalize(readDrugFromPage());
    if (!drugKey) return;

    if (drugKey === normalize(lastDrugKey)) return;

    lastDrugKey = drugKey;
    triggerAutoFill("Drug changed -> " + drugKey);
  }

  function scheduleCheck(reason) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      checkNow(reason);
    }, 250);
  }

  const observer = new MutationObserver(() => {
    scheduleCheck("mutation");
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true
  });

  const onUiEvent = () => scheduleCheck("ui-event");
  document.addEventListener("click", onUiEvent, true);
  document.addEventListener("change", onUiEvent, true);
  document.addEventListener("input", onUiEvent, true);
  document.addEventListener("keyup", onUiEvent, true);

  setInterval(() => {
    scheduleCheck("interval");
  }, 1800);

  setTimeout(() => {
    checkNow("init");
  }, 1200);
})();
