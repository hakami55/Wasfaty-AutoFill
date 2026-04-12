// background.js (stable like old behavior, but supports DRUG CODE matching)
// Base: original behavior from your uploaded file (cooldown, matching, fill) :contentReference[oaicite:1]{index=1}

const CDP_VERSION = "1.3";
const KEY = "wasfaty_profiles_v1";
const KEY_SPEED = "wasfaty_entry_speed";
const REFILL_QUEUE_KEY = "wasfaty_refill_queue_tmp";
const REFILL_ALARM_NAME = "wasfaty_refill_batch_alarm";
const FAVORITES_QUEUE_KEY = "wasfaty_favorites_queue_tmp";
const FAVORITES_ALARM_NAME = "wasfaty_favorites_batch_alarm";
const REFILL_METRICS_KEY = "wasfaty_refill_metrics_v1";
const REFILL_METRICS_MAX = 250;

// Speed timing multipliers based on user-selected speed level
const SPEED_MULTIPLIERS = {
  1: 1.5,  // Slow - 1.5x delays
  2: 1.2,  // Slow-Medium - 1.2x delays
  3: 1.0,  // Medium - no change (default)
  4: 0.7,  // Medium-Fast - 0.7x delays
  5: 0.4   // Fast - 0.4x delays
};

// Auto-fill cooldown (prevents repeated auto fill on same drug)
let lastAutoDrugKey = ""; // ✅ now a stable key: "C:code" or "T:text"
let lastAutoTime = 0;
let currentSpeedMultiplier = 1.0; // Will be updated from storage
const tabDebuggerBusy = new Set(); // Prevent concurrent debugger sessions per tab
const refillBatchRunningTabs = new Set();
const favoritesBatchRunningTabs = new Set();
let refillMetricsBuffer = [];
let refillMetricsFlushTimer = null;
let refillMetricsFlushing = false;

// Helper function to apply speed multiplier to delays
async function getSpeedMultiplier() {
  const res = await chrome.storage.local.get([KEY_SPEED]);
  const speed = res[KEY_SPEED] ?? 3;
  return SPEED_MULTIPLIERS[speed] || 1.0;
}

// ---------- CDP helpers ----------
function attach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, CDP_VERSION, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(err);
      else resolve();
    });
  });
}
function detach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      const err = chrome.runtime.lastError;
      // Avoid uncaught runtime noise when already detached.
      if (err && !/Debugger is not attached/i.test(String(err.message || ""))) {
        console.warn("[detach]", err.message || err);
      }
      resolve();
    });
  });
}
function send(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(err);
      else resolve(result);
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evalValue(tabId, expression) {
  const res = await send(tabId, "Runtime.evaluate", { 
    expression, 
    returnByValue: true,
    awaitPromise: true
  });
  return res?.result?.value;
}

// ---------- storage ----------
async function getProfiles() {
  const res = await chrome.storage.local.get([KEY]);
  return Array.isArray(res[KEY]) ? res[KEY] : [];
}

async function removeProfilesByIds(ids) {
  const list = Array.isArray(ids) ? ids.map((x) => String(x || "").trim()).filter(Boolean) : [];
  if (!list.length) return;
  const cur = await getProfiles();
  const keep = cur.filter((p) => !list.includes(String(p?.id || "")));
  await chrome.storage.local.set({ [KEY]: keep });
}

function metricValue(v, depth = 0) {
  if (v === null || v === undefined) return v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return v.slice(0, 220);
  if (depth >= 2) return String(v).slice(0, 220);
  if (Array.isArray(v)) return v.slice(0, 12).map((x) => metricValue(x, depth + 1));
  if (typeof v === "object") {
    const out = {};
    let i = 0;
    for (const [k, val] of Object.entries(v)) {
      out[String(k).slice(0, 60)] = metricValue(val, depth + 1);
      i += 1;
      if (i >= 16) break;
    }
    return out;
  }
  return String(v).slice(0, 220);
}

function queueRefillMetric(event, data = {}) {
  try {
    const item = { ts: Date.now(), event: String(event || "unknown") };
    if (data && typeof data === "object") {
      for (const [k, v] of Object.entries(data)) {
        item[k] = metricValue(v);
      }
    }
    refillMetricsBuffer.push(item);
    if (refillMetricsBuffer.length > REFILL_METRICS_MAX) {
      refillMetricsBuffer = refillMetricsBuffer.slice(-REFILL_METRICS_MAX);
    }
    if (!refillMetricsFlushTimer) {
      refillMetricsFlushTimer = setTimeout(() => {
        refillMetricsFlushTimer = null;
        flushRefillMetricsNow().catch(() => {});
      }, 350);
    }
  } catch (_) {}
}

async function flushRefillMetricsNow() {
  if (refillMetricsFlushing) return;
  if (!refillMetricsBuffer.length) return;
  refillMetricsFlushing = true;
  try {
    const chunk = refillMetricsBuffer.splice(0, refillMetricsBuffer.length);
    const res = await chrome.storage.local.get([REFILL_METRICS_KEY]);
    const existing = Array.isArray(res?.[REFILL_METRICS_KEY]) ? res[REFILL_METRICS_KEY] : [];
    const merged = existing.concat(chunk);
    if (merged.length > REFILL_METRICS_MAX) {
      merged.splice(0, merged.length - REFILL_METRICS_MAX);
    }
    await chrome.storage.local.set({ [REFILL_METRICS_KEY]: merged });
  } catch (_) {
    // Best effort logger. Do not break refill flow.
  } finally {
    refillMetricsFlushing = false;
    if (refillMetricsBuffer.length && !refillMetricsFlushTimer) {
      refillMetricsFlushTimer = setTimeout(() => {
        refillMetricsFlushTimer = null;
        flushRefillMetricsNow().catch(() => {});
      }, 400);
    }
  }
}

// ---------- normalize ----------
function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCode(s) {
  return String(s || "")
    .trim()
    .replace(/[^\d-]+/g, "")
    .replace(/-+/g, "-");
}

function looksLikeCode(s) {
  const x = normalizeCode(s);
  // Wasfaty codes like 205003-039-074
  return /^\d[\d-]{6,}$/.test(x);
}

function stripStrength(s) {
  // Remove common strength/unit patterns so profiles can match across 500/750/etc.
  if (!s) return "";
  let x = String(s).toLowerCase();
  x = x.replace(/\b\d+(?:\.\d+)?\s*(mg|mcg|µg|g|gram|grams|iu|unit|units|international\s*unit(?:s)?|ml|mL|mm|%|meq)\b/g, " ");
  x = x.replace(/\b\d+(?:\.\d+)?\b/g, " ");
  x = x.replace(/\s+/g, " ").trim();
  return x;
}

function findProfileByCode(profiles, code) {
  const needle = normalizeCode(code || "");
  if (!needle) return null;
  const list = Array.isArray(profiles) ? profiles : [];
  // Prefer newest profile when duplicates exist (temp profiles are appended).
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    const mRaw = p?.match || p?.matchText || p?.matchtext || "";
    if (!mRaw) continue;
    if (normalizeCode(mRaw) === needle) return p;
  }
  return null;
}

// ✅ NEW: Match by CODE if profile.match is a code, otherwise keep old text matching
function bestProfileMatch(profiles, drugInfo) {
  const drugCode = normalizeCode(drugInfo?.code || "");
  const drugText = String(drugInfo?.text || "");

  const drugTextNorm = normalizeText(drugText);
  const drugBase = stripStrength(drugTextNorm);

  let best = null;
  let bestScore = -1;

  for (const p of (profiles || [])) {
    const mRaw = p.match || p.matchText || p.matchtext || "";
    if (!mRaw) continue;

    // 1) If profile match is CODE -> exact match against current drug code
    if (looksLikeCode(mRaw)) {
      if (!drugCode) continue; // no code available on page yet
      const mCode = normalizeCode(mRaw);
      if (mCode && mCode === drugCode) return p; // perfect
      continue;
    }

    // 2) Otherwise fallback to old text matching (same as your original)
    const mNorm = normalizeText(mRaw);
    const mBase = stripStrength(mNorm);

    const hit =
      (mNorm && drugTextNorm.includes(mNorm)) ||
      (mBase && drugBase.includes(mBase));

    if (!hit) continue;

    const score = Math.max(mNorm.length, mBase.length * 1.2);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  return best;
}

// ✅ NEW: Read BOTH drug text + drug code (code preferred when present)
// Returns: { code:"205003-039-074", text:"Sitagliptin 100 mg ...", key:"C:205003-039-074" } OR text-key if no code
async function readCurrentDrug(tabId) {
  const expr = `
(() => {
  function isVisible(el){
    if(!el) return false;
    const s = getComputedStyle(el);
    if(s.display==="none" || s.visibility==="hidden" || s.opacity==="0") return false;
    const r = el.getBoundingClientRect();
    return r.width>5 && r.height>5;
  }

  function extractCode(str){
    const m = String(str || "").match(/Code:\\s*([0-9\\-]+)/i);
    return m ? m[1] : "";
  }

  // find the Drugs block container by the heading "Drugs"
  const drugsHeader = [...document.querySelectorAll("*")]
    .find(e => (e.textContent||"").trim().startsWith("Drugs"));
  const container = drugsHeader ? (drugsHeader.closest("div") || document) : document;

  // Prefer the auto-complete label that shows the selected drug (exclude placeholders like "Select Drug")
  const labelEls = [...container.querySelectorAll(".autocomplete-select-label, .auto-complete-select-label")]
    .filter(isVisible)
    .filter(el => {
      const t = (el.textContent || "").trim();
      return t && !/^select\\s+drug/i.test(t);
    });

  // Helper: pick {text, code} from an element
  function pickFromEl(el){
    const text = (el?.textContent || "").trim();
    const title = (el?.getAttribute?.("title") || "").trim();
    const code = extractCode(title) || extractCode(text);
    return { text, code };
  }

  // 1) label
  if (labelEls.length) {
    const info = pickFromEl(labelEls[0]);
    return { code: info.code || "", text: info.text || "" };
  }

  // 2) generic-drug-text
  const genericEls = [...container.querySelectorAll("span.generic-drug-text")]
    .filter(isVisible);

  if (genericEls.length) {
    const info = pickFromEl(genericEls[0]);
    return { code: info.code || "", text: info.text || "" };
  }

  // 3) bold fallback
  const boldEls = [...container.querySelectorAll(".drug-text-wrapper b, span.text-red b, b")]
    .filter(isVisible);

  if (boldEls.length) {
    const info = pickFromEl(boldEls[0]);
    return { code: info.code || "", text: info.text || "" };
  }

  return { code:"", text:"" };
})()
`;
  const info = await evalValue(tabId, expr);

  const code = normalizeCode(info?.code || "");
  const text = String(info?.text || "").trim();

  // ✅ Stable key (prevents jitter): prefer code when present, else use text
  const key = code ? ("C:" + code) : ("T:" + normalizeText(text));

  return { code, text, key };
}

/**
 * ✅ Fill only empty fields based on a profile.
 * (Kept exactly like your old behavior to avoid glitches)
 * Supports BOTH:
 *  - Old flat profile: {take,times,every,duration,...}
 *  - New profile: {type, data:{...}} from profiles page
 */
async function runFillUsingProfile(tabId, profile) {
  const speedMult = await getSpeedMultiplier();
  
  // Check if auto-focus on drug is enabled globally
  const settingsRes = await chrome.storage.local.get(["wasfaty_settings_v1"]);
  const settings = settingsRes["wasfaty_settings_v1"] || {};
  const enableAutoFocusDrug = settings.autoFocusNextDrug !== false;
  
  const p = (profile && profile.data && typeof profile.data === "object")
    ? { ...profile.data, type: profile.type || "standard", __tempRefill: profile.__tempRefill === true }
    : { ...profile };

  // NOTE: This body is unchanged from your original file behavior (same fill strategy).
  // (Copied from your uploaded background.js :contentReference[oaicite:2]{index=2})
  const expr = `
(async () => {
  const p = ${JSON.stringify(p)};
  const speedMult = ${speedMult};
  const enableAutoFocusDrug = ${enableAutoFocusDrug};
  const sleep = (ms) => new Promise(r => setTimeout(r, Math.round(ms * speedMult)));

  function visible(el) {
    if (!el) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  function getVal(input) {
    return input ? String(input.value || "").trim() : "";
  }

  function focusAndSetIfEmpty(input, val) {
    if (!input) return false;
    if (getVal(input) !== "") return false;

    try { input.focus(); } catch(e) {}

    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(input, String(val));
    else input.value = String(val);

    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "0", bubbles: true }));

    try { input.blur(); } catch(e) {}
    return true;
  }

  function hasBlockingValidationErrors() {
    const errNodes = [...document.querySelectorAll(".error-text, .text-danger, .error, .validation-message")]
      .filter(visible);
    if (!errNodes.length) return false;
    const txt = errNodes
      .map((n) => (n.textContent || "").replace(/\s+/g, " ").trim().toLowerCase())
      .filter(Boolean)
      .join(" | ");
    if (!txt) return false;
    return /please fill the mandatory values|dosage value entered is not allowed|dosage should be a multiple|can't be empty|can not be empty|required|max value must be|not allowed|invalid/.test(txt);
  }

  function getDrugScopes() {
    return [...document.querySelectorAll(".auto-complete-wrapper.auto-complete-select-mode, .auto-complete-wrapper, .auto-complete-select-mode")]
      .filter((s) => (s.textContent || "").includes("Drug"))
      .filter(visible);
  }

  function isEmptyDrugScope(scope) {
    const label = scope?.querySelector(".autocomplete-select-label, .auto-complete-select-label");
    const text = (label?.textContent || "").trim();
    return !text || /^select\\s+drug/i.test(text) || /^select/i.test(text);
  }

  function hasEmptyDrugScope() {
    return getDrugScopes().some(isEmptyDrugScope);
  }

  async function waitForManualAddAfterValidation(timeoutMs = 240000) {
    const start = Date.now();
    const hadEmptyAtStart = hasEmptyDrugScope();
    const nonEmptyStartCount = getDrugScopes().filter((s) => !isEmptyDrugScope(s)).length;

    while ((Date.now() - start) < timeoutMs) {
      if (!document?.body) return { ok: false, why: "document_unavailable" };

      const hasErrors = hasBlockingValidationErrors();
      const hasEmptyNow = hasEmptyDrugScope();
      const nonEmptyNowCount = getDrugScopes().filter((s) => !isEmptyDrugScope(s)).length;

      // Continue only after user corrected values and added successfully.
      if (!hasErrors && ((hasEmptyNow && !hadEmptyAtStart) || (nonEmptyNowCount < nonEmptyStartCount))) {
        return { ok: true, reason: "manual_add_completed" };
      }

      await sleep(240);
    }

    return { ok: false, why: "manual_add_timeout" };
  }

  async function forceSet(selector, value, maxTries = 4) {
    const v = (value == null) ? "" : String(value);
    if (v.trim() === "") return false;

    for (let i = 0; i < maxTries; i++) {
      const el = document.querySelector(selector);
      if (!el) { await sleep(220); continue; }

      const cur = String(el.value || "").trim();
      if (cur === v) return true;

      try { el.focus(); } catch(e) {}

      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, v);
      else el.value = v;

      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: "0", bubbles: true }));

      try { el.blur(); } catch(e) {}

      await sleep(350);

      const el2 = document.querySelector(selector);
      const cur2 = el2 ? String(el2.value || "").trim() : "";
      if (cur2 === v) return true;
    }

    return false;
  }

  async function waitForUserFillAndBlurSelector(selector, timeoutMs = 180000) {
    const start = Date.now();

    let el = document.querySelector(selector);
    if (el) {
      try { el.scrollIntoView({ block: "center", inline: "nearest" }); } catch(e) {}
      try { el.focus(); } catch(e) {}
    }

    let value = "";
    while ((Date.now() - start) < timeoutMs) {
      el = document.querySelector(selector);
      if (el) {
        value = String(el.value || "").trim();
        if (value !== "") break;
        try { if (document.activeElement !== el) el.focus(); } catch(e){}
      }
      await sleep(120);
    }
    if (!value) return { ok:false, why:"timeout_wait_value" };

    const start2 = Date.now();
    while ((Date.now() - start2) < timeoutMs) {
      el = document.querySelector(selector);

      if (!el || !el.isConnected) return { ok:true, value, reason:"element_replaced" };

      const curVal = String(el.value || "").trim();
      if (curVal !== "") value = curVal;

      const active = document.activeElement;
      if (active !== el) return { ok:true, value, reason:"focus_left" };

      await sleep(200);
    }

    return { ok:true, value, reason:"forced_continue" };
  }

  async function clickAddButtonIfNeeded() {
    if (!p.clickAdd) return { ok: true, skipped: true };
    const visibleButtons = [...document.querySelectorAll("button")].filter((b) => {
      if (!b || b.disabled) return false;
      const st = getComputedStyle(b);
      if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
      const r = b.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    });
    const btn =
      visibleButtons.find((b) => /^\s*add\s*$/i.test((b.textContent || "").trim())) ||
      visibleButtons.find((b) => {
        const t = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        return t.includes("add") && !t.includes("dose") && !t.includes("+");
      });
    if (!btn) return { ok: false, why: "add_button_not_found" };

    btn.click();
    await sleep(420);

    if (hasBlockingValidationErrors()) {
      const manualRes = await waitForManualAddAfterValidation(240000);
      if (manualRes?.ok) {
        return { ok: true, manual: true, reason: manualRes.reason };
      }
      return { ok: false, why: manualRes?.why || "add_validation_failed" };
    }

    return { ok: true };
  }

  async function autoFocusNextDrugFilter() {
    // Wait for new drug row to appear after Add click
    await sleep(500);
    
    // Retry multiple times in case element takes time to appear
    for (let attempt = 0; attempt < 8; attempt++) {
      const scopes = [...document.querySelectorAll(".auto-complete-wrapper.auto-complete-select-mode, .auto-complete-wrapper, .auto-complete-select-mode")]
        .filter(s => (s.textContent || "").includes("Drug"));
      const targetScope = scopes.find(s => {
        const label = s.querySelector(".autocomplete-select-label, .auto-complete-select-label");
        const txt = (label?.textContent || "").trim();
        return !txt || /^select\\s+drug/i.test(txt) || /^select/i.test(txt);
      }) || scopes[scopes.length - 1];
      const filterInput =
        targetScope?.querySelector('input.form-control[placeholder="Filter the options"], input.form-control.search-input, input.form-control') ||
        [...document.querySelectorAll('input.form-control[placeholder="Filter the options"], input.form-control.search-input, input.form-control')].pop();
      
      if (filterInput) {
        
        try { 
          filterInput.scrollIntoView({ block: "center", inline: "nearest" }); 
        } catch(e) {}
        try { 
          filterInput.focus(); 
          filterInput.select();
        } catch(e) {
        }
        return;
      }
      
      await sleep(150);
    }
    
  }

  async function pickRefills(optionText) {
    if (!optionText) return { ok:false, why:"no optionText" };

    const container = document.querySelector('[data-stateportionname="Refills"]');
    if (!container) return { ok:false, why:"Refills not found" };

    const label = container.querySelector(".autocomplete-select-label");
    if (!label) return { ok:false, why:"Refills label missing" };

    const titleNow = (label.getAttribute("title") || "").trim();
    const textNow = (label.textContent || "").trim();
    if (titleNow === optionText || textNow === optionText) return { ok:true, skipped:true };

    label.click();
    await sleep(200);

    let panel = null;
    for (let i = 0; i < 25; i++) {
      panel = container.querySelector(".auto-complete-panel");
      const items = panel?.querySelectorAll(".auto-complete-items .a-item");
      if (panel && items && items.length) break;
      await sleep(120);
    }
    if (!panel) return { ok:false, why:"Refills panel not found" };

    const options = [...panel.querySelectorAll(".auto-complete-items .a-item")]
      .map(item => item.querySelector("div"))
      .filter(Boolean)
      .filter(visible);

    const hit = options.find(d => (d.textContent || "").trim() === optionText);
    if (!hit) return { ok:false, why:"Refills option not found: " + optionText };

    hit.click();
    await sleep(350);

    const title = (label.getAttribute("title") || "").trim();
    const text  = (label.textContent || "").trim();
    return { ok: (title === optionText || text === optionText) };
  }

  const isSpecialMedicationForm =
    !!document.querySelector('textarea[name="Instructions"]') ||
    !!document.querySelector('input[name="Quantity"]');

  const isSpecialProfile =
    (p.type === "special") ||
    (p.profileType === "special") ||
    (p.isSpecial === true);

  const hasExplicitType =
    (p.type === "special" || p.type === "standard") ||
    (p.profileType === "special" || p.profileType === "standard") ||
    (p.isSpecial === true || p.isSpecial === false);
  const shouldUseSpecialMode = isSpecialProfile || (!hasExplicitType && isSpecialMedicationForm);

  if (shouldUseSpecialMode) {
    const applied = { specialInstructions:false, quantity:false, duration:false, refills:false, addClicked:false };

    applied.specialInstructions = await forceSet(
      'textarea[name="Instructions"]',
      (p.specialInstructions ?? p.instructions ?? "")
    );

    await sleep(220);

    applied.quantity = await forceSet(
      'input[name="Quantity"]',
      (p.quantity ?? "")
    );

    await sleep(250);

    if (p.refills !== undefined && p.refills !== null && String(p.refills).trim() !== "") {
      const r = await pickRefills(String(p.refills));
      applied.refills = !!r.ok;
    }

    await sleep(350);
    {
      const readDurationState = () => {
        const durationEl =
          document.querySelector('input[name="Duration"]') ||
          document.querySelector('input[name="For"]');
        const currentValue = String(durationEl?.value || "").trim();
        const root =
          durationEl?.closest?.('[data-stateportionname="Duration"]') ||
          durationEl?.closest?.(".input-wrapper") ||
          durationEl?.closest?.(".form-group") ||
          durationEl?.closest?.(".row") ||
          document;
        const errorNode = root.querySelector?.(".error-text, .text-danger, .error, .validation-message");
        const errorText = String(errorNode?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        return { currentValue, errorText };
      };

      const durationValue = String(p.duration ?? "").trim();
      if (durationValue) {
        const a = await forceSet('input[name="Duration"]', durationValue);
        const b = a ? true : await forceSet('input[name="For"]', durationValue);
        applied.duration = !!(a || b);
        await sleep(350);

        // For temp special refill drugs: if site rejects configured fallback value,
        // switch to manual duration entry and continue after blur.
        if (p.__tempRefill === true) {
          const st = readDurationState();
          const rejected =
            !st.currentValue ||
            /can't be empty|can not be empty|required|max value|not allowed|invalid/.test(st.errorText);
          if (rejected) {
            const waited = await waitForUserFillAndBlurSelector('input[name="Duration"], input[name="For"]', 180000);
            if (!waited.ok) {
              return { ok: false, mode: "special", error: "User did not fill Duration", why: waited.why };
            }
            p.duration = String(waited.value || "").trim();
            applied.duration = !!p.duration;
          }
        }
      } else if (p.__tempRefill === true && p.manualDuration === true) {
        const waited = await waitForUserFillAndBlurSelector('input[name="Duration"], input[name="For"]', 180000);
        if (!waited.ok) {
          return { ok: false, mode: "special", error: "User did not fill Duration", why: waited.why };
        }
        p.duration = String(waited.value || "").trim();
        applied.duration = !!p.duration;
      }
    }

    await sleep(450);
    if (p.specialInstructions || p.instructions) {
      await forceSet('textarea[name="Instructions"]', (p.specialInstructions ?? p.instructions ?? ""), 2);
    }
    if (String(p.duration ?? "").trim() !== "") {
      const d = String(p.duration ?? "").trim();
      const okA = await forceSet('input[name="Duration"]', d, 2);
      if (!okA) await forceSet('input[name="For"]', d, 2);
    }

    await sleep(200);

    const addRes = await clickAddButtonIfNeeded();
    applied.addClicked = !!(addRes?.ok && !addRes?.skipped);
    if (!addRes?.ok) {
      return { ok: false, mode: "special", error: addRes?.why || "add_failed", applied };
    }
    if (applied.addClicked && enableAutoFocusDrug) {
      await autoFocusNextDrugFilter();
    }
    return { ok: true, mode: "special", applied };
  }

  async function pickFromScopeText(scopeText, optionText) {
    if (!optionText) return { ok:false, why:"no optionText" };

    const scope = [...document.querySelectorAll(".auto-complete-wrapper.auto-complete-select-mode, .auto-complete-wrapper, .auto-complete-select-mode")]
      .find(s => (s.textContent || "").includes(scopeText)) || null;

    if (!scope) return { ok:false, why:"scope not found: " + scopeText };

    const label = scope.querySelector(".autocomplete-select-label");
    if (!label) return { ok:false, why:"label not found: " + scopeText };

    const titleNow = (label.getAttribute("title") || "").trim();
    const textNow = (label.textContent || "").trim();
    if (titleNow === optionText || textNow === optionText) return { ok:true, skipped:true };

    label.click();
    await sleep(200);

    let panel = null;
    for (let i = 0; i < 25; i++) {
      panel =
        scope.querySelector(".auto-complete-panel.show-sug-panel") ||
        scope.querySelector(".auto-complete-panel") ||
        document.querySelector(".auto-complete-panel.show-sug-panel");
      if (panel && panel.querySelectorAll(".auto-complete-items .a-item").length) break;
      await sleep(120);
    }
    if (!panel) return { ok:false, why:"panel not found: " + scopeText };

    const options = [...panel.querySelectorAll(".auto-complete-items .a-item")]
      .map(item => item.querySelector("div"))
      .filter(Boolean)
      .filter(visible);

    const hit = options.find(d => (d.textContent || "").trim() === optionText);
    if (!hit) return { ok:false, why:"option not found: " + optionText };

    hit.click();
    await sleep(250);

    const title = (label.getAttribute("title") || "").trim();
    const text  = (label.textContent || "").trim();
    return { ok: (title === optionText || text === optionText) };
  }

  async function pickDayFrequencyTypeId(optionText) {
    if (!optionText) return { ok:false, why:"no optionText" };

    const container = document.querySelector('[data-stateportionname="FrequencyTypeId"]');
    if (!container) return { ok:false, why:"FrequencyTypeId not found" };

    const label = container.querySelector(".autocomplete-select-label");
    if (!label) return { ok:false, why:"Day label missing" };

    const titleNow = (label.getAttribute("title") || "").trim();
    const textNow = (label.textContent || "").trim();
    if (titleNow === optionText || textNow === optionText) return { ok:true, skipped:true };

    label.click();
    await sleep(200);

    let panel = null;
    for (let i = 0; i < 25; i++) {
      panel = container.querySelector(".auto-complete-panel");
      const items = panel?.querySelectorAll(".auto-complete-items .a-item");
      if (panel && items && items.length) break;
      await sleep(120);
    }
    if (!panel) return { ok:false, why:"Day panel not found" };

    const options = [...panel.querySelectorAll(".auto-complete-items .a-item")]
      .map(item => item.querySelector("div"))
      .filter(Boolean)
      .filter(visible);

    const hit = options.find(d => (d.textContent || "").trim() === optionText);
    if (!hit) return { ok:false, why:"Day option not found: " + optionText };

    hit.click();
    await sleep(250);

    const title = (label.getAttribute("title") || "").trim();
    const text  = (label.textContent || "").trim();
    return { ok: (title === optionText || text === optionText) };
  }

  const takeInput = document.querySelector('input[name="UnitPerFrequency"]');
  const timesInput = document.querySelector('input[name="FrequencyValue"]');
  const durationInput = document.querySelector('input[name="Duration"]') || document.querySelector('input[name="For"]');
  const everyInput = document.querySelector('input[name="Every"]') || document.querySelector('input[name="EveryValue"]');

  const applied = {
    Take: false,
    Times: false,
    Every: false,
    Duration: false,
    DoseTiming: false,
    Day: false,
    Refills: false,
    Add_clicked: false
  };

  if (takeInput && String(takeInput.value || "").trim() === "" && (!p.take || String(p.take).trim() === "")) {
    const waited = await waitForUserFillAndBlurSelector('input[name="UnitPerFrequency"]', 180000);
    if (!waited.ok) return { ok:false, mode:"normal", error:"User did not fill Take", why: waited.why };
    p.take = waited.value;
  }

  if (p.take) applied.Take = focusAndSetIfEmpty(takeInput, p.take);
  if (p.times) applied.Times = focusAndSetIfEmpty(timesInput, p.times);
  if (p.every && everyInput) applied.Every = focusAndSetIfEmpty(everyInput, p.every);

  await sleep(250);

  if (timesInput && String(timesInput.value || "").trim() === "" && (!p.times || String(p.times).trim() === "")) {
    const waited = await waitForUserFillAndBlurSelector('input[name="FrequencyValue"]', 180000);
    if (!waited.ok) return { ok:false, mode:"normal", error:"User did not fill Times", why: waited.why };
    p.times = waited.value;
  }

  await sleep(250);

  if (p.doseTiming) {
    const r = await pickFromScopeText("Dose Timing", p.doseTiming);
    applied.DoseTiming = !!r.ok;
  }

  await sleep(250);

  if (p.dayType) {
    const r = await pickDayFrequencyTypeId(p.dayType);
    applied.Day = !!r.ok;
  }

  await sleep(250);

  if (p.refills !== undefined && p.refills !== null && String(p.refills).trim() !== "") {
    const r = await pickRefills(String(p.refills));
    applied.Refills = !!r.ok;
  }

  await sleep(350);

  if (p.duration && durationInput) {
    if (p.__tempRefill === true) {
      const d = String(p.duration || "").trim();
      const forcedA = await forceSet('input[name="Duration"]', d, 3);
      const forcedB = forcedA ? true : await forceSet('input[name="For"]', d, 3);
      applied.Duration = !!(forcedA || forcedB);
    } else {
      applied.Duration = focusAndSetIfEmpty(durationInput, p.duration);
    }
  }

  await sleep(250);

  if (p.clickAdd) {
    const addRes = await clickAddButtonIfNeeded();
    applied.Add_clicked = !!(addRes?.ok && !addRes?.skipped);
    if (!addRes?.ok) {
      return { ok:false, mode:"normal", error: addRes?.why || "add_failed", applied };
    }
    if (applied.Add_clicked && enableAutoFocusDrug) {
      await autoFocusNextDrugFilter();
    }
  }

  return { ok:true, mode:"normal", applied };
})()
`;
  return await evalValue(tabId, expr);
}

// ---------- Apply Favorite Drug ------- 
async function applyFavoriteDrugOnPage(tabId, drugCode) {
  try {
    const speedMult = await getSpeedMultiplier();
    const sleep = (ms) => new Promise(r => setTimeout(r, Math.round(ms * speedMult)));
    const clearTargetMarker = async () => {
      try {
        await evalValue(tabId, `(() => {
          document.querySelectorAll('[data-wf-fav-target="1"]').forEach(el => el.removeAttribute("data-wf-fav-target"));
          return true;
        })()`);
      } catch (_) {}
    };
    
    
    // Step 1: Pick target drug row (first empty "Select Drug" row).
    // Do NOT click Add from this routine; Wasfaty can crash on forced add click.
    let result = null;
    let targetReady = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      result = await evalValue(tabId, `
(() => {
  function isVisible(el) {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 3 && r.height > 3;
  }
  function allDrugScopes() {
    return [...document.querySelectorAll(".auto-complete-wrapper.auto-complete-select-mode, .auto-complete-wrapper, .auto-complete-select-mode")]
      .filter(s => (s.textContent || "").includes("Drug"))
      .filter(s => s.querySelector(".autocomplete-select-label, .auto-complete-select-label, .auto-complete-panel, input.form-control"));
  }
  function isEmptyDrugScope(scope) {
    const label = scope?.querySelector(".autocomplete-select-label, .auto-complete-select-label");
    const text = (label?.textContent || "").trim();
    return !text || /^select\\s+drug/i.test(text) || /^select/i.test(text);
  }

  // Clear old temporary marker
  document.querySelectorAll('[data-wf-fav-target="1"]').forEach(el => el.removeAttribute("data-wf-fav-target"));

  const scopes = allDrugScopes();
  let drugsScope = scopes.find(isEmptyDrugScope) || null;
  if (!drugsScope) return { ok:false, reason:"no_empty_row", scopeCount: scopes.length };

  if (drugsScope) {
    drugsScope.setAttribute("data-wf-fav-target", "1");
    // Close old panels
    const oldPanels = drugsScope.querySelectorAll(".auto-complete-panel");
    oldPanels.forEach(p => {
      p.classList.remove("show-sug-panel");
      // Do not force hide via inline style; it can freeze the control.
      if (p.style?.display === "none") p.style.display = "";
    });
    // Clear old filters
    const oldFilters = drugsScope.querySelectorAll('input.form-control[placeholder="Filter the options"], input.form-control.search-input, input.form-control');
    oldFilters.forEach(f => { f.value = ""; });
  }
  return { ok: !!drugsScope, scopeCount: scopes.length };
})()
`);

      if (result?.ok) {
        targetReady = true;
        break;
      }
      await sleep(320);
    }

    if (!targetReady) {
      await clearTargetMarker();
      if (result?.reason === "no_empty_row") return { ok: false, error: "no_empty_row" };
      return { ok: false, error: result?.reason || "Drugs scope not found" };
    }

    await sleep(300);
    
    // Step 2: Find and click the label to open dropdown
    result = await evalValue(tabId, `
(() => {
  const drugsScope = document.querySelector('[data-wf-fav-target="1"]');
  const label = drugsScope?.querySelector(".autocomplete-select-label, .auto-complete-select-label");
  if (label) {
    label.click();
    return { ok: true };
  }
  return { ok: false, error: "Label not found" };
})()
`);
    
    if (!result?.ok) {
      await clearTargetMarker();
      return { ok: false, error: "Drug label not found" };
    }
    
    await sleep(500);
    
    // Step 3: Wait for dropdown panel to appear
    let panelFound = false;
    for (let i = 0; i < 60; i++) {
      result = await evalValue(tabId, `
(() => {
  const drugsScope = document.querySelector('[data-wf-fav-target="1"]');
  const panel = drugsScope?.querySelector(".auto-complete-panel");
  const filterInput = panel?.querySelector('input.form-control[placeholder="Filter the options"], input.form-control.search-input, input.form-control');
  return { ok: !!panel && !!filterInput };
})()
`);
      if (result?.ok) {
        panelFound = true;
        break;
      }
      await sleep(100);
    }
    
    if (!panelFound) {
      await clearTargetMarker();
      return { ok: false, error: "Drug filter panel did not appear" };
    }
    
    await sleep(200);
    
    // Step 4: Focus filter input
    result = await evalValue(tabId, `
(() => {
  const drugsScope = document.querySelector('[data-wf-fav-target="1"]');
  const panel = drugsScope?.querySelector(".auto-complete-panel");
  const filterInput = panel?.querySelector('input.form-control[placeholder="Filter the options"], input.form-control.search-input, input.form-control');
  
  if (filterInput) {
    // Clear the filter
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const realSetter = descriptor?.set;
    if (realSetter) {
      realSetter.call(filterInput, "");
    } else {
      filterInput.value = "";
    }
    
    // Focus it
    filterInput.click();
    filterInput.focus();
    filterInput.select();
    return { ok: true };
  }
  return { ok: false, error: "Filter input not found" };
})()
`);
    
    if (!result?.ok) {
      await clearTargetMarker();
      return { ok: false, error: "Failed to focus filter input" };
    }
    
    await sleep(200);
    
    // Step 5: Type the drug code character by character
    for (let charIndex = 0; charIndex < drugCode.length; charIndex++) {
      const char = drugCode[charIndex];
      const newValue = drugCode.substring(0, charIndex + 1);
      
      await evalValue(tabId, `
(() => {
  const drugsScope = document.querySelector('[data-wf-fav-target="1"]');
  const panel = drugsScope?.querySelector(".auto-complete-panel");
  const filterInput = panel?.querySelector('input.form-control[placeholder="Filter the options"], input.form-control.search-input, input.form-control');
  
  if (!filterInput) return { ok: false };
  
  const char = "${char}";
  const newValue = "${newValue}";
  
  // Dispatch keydown
  filterInput.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
  
  // Use real setter to change value
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const realSetter = descriptor?.set;
  if (realSetter) {
    realSetter.call(filterInput, newValue);
  } else {
    filterInput.value = newValue;
  }
  
  // Dispatch input event
  filterInput.dispatchEvent(new InputEvent("input", { bubbles: true, data: char }));
  
  // Dispatch keyup
  filterInput.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
  
  return { ok: true };
})()
`);
      await sleep(80);
    }
    
    // Wait briefly for async suggestions. Keep polling so we do not always pay a fixed long delay.
    let optionsReady = false;
    for (let i = 0; i < 25; i++) {
      result = await evalValue(tabId, `
(() => {
  const drugsScope = document.querySelector('[data-wf-fav-target="1"]');
  const panel = drugsScope?.querySelector(".auto-complete-panel");
  const items = panel?.querySelectorAll(".auto-complete-items .a-item") || [];
  return { ok: true, itemCount: items.length };
})()
`);
      if ((result?.itemCount || 0) > 0) {
        optionsReady = true;
        break;
      }
      await sleep(80);
    }
    if (!optionsReady) await sleep(180);
    
    // Step 6: Find and click matching drug item
    let found = false;
    let sawNoResults = false;
    for (let i = 0; i < 40; i++) {
      result = await evalValue(tabId, `
(() => {
  const drugsScope = document.querySelector('[data-wf-fav-target="1"]');
  const panel = drugsScope?.querySelector(".auto-complete-panel");
  const noResultsNode = [...(panel?.querySelectorAll?.(".margin") || [])]
    .find(el => /sorry,\\s*but\\s*no\\s*results\\s*found\\.?/i.test(String(el.textContent || "")));
  if (noResultsNode) {
    return { ok: true, found: false, noResults: true };
  }
  const items = panel?.querySelectorAll(".auto-complete-items .a-item") || [];
  
  const drugCode = "${drugCode}";
  for (const div of items) {
    const text = (div.textContent || "").trim();
    if (text.includes(drugCode)) {
      div.click();
      return { ok: true, found: true, text: text };
    }
  }
  return { ok: true, found: false, itemCount: items.length };
})()
`);
      
      if (result?.noResults) {
        sawNoResults = true;
        break;
      }
      if (result?.found) {
        found = true;
        break;
      }
      await sleep(200);
    }
    
    if (!found) {
      await clearTargetMarker();
      if (sawNoResults) {
        return { ok: false, error: "no_results_found" };
      }
      return { ok: false, error: "Drug not found in dropdown" };
    }
    
    // Wait until selected drug is committed on the target row
    let committed = false;
    for (let i = 0; i < 35; i++) {
      result = await evalValue(tabId, `
(() => {
  const drugsScope = document.querySelector('[data-wf-fav-target="1"]');
  const label = drugsScope?.querySelector(".autocomplete-select-label, .auto-complete-select-label");
  const text = (label?.textContent || "").trim();
  const title = (label?.getAttribute("title") || "").trim();
  const code = "${drugCode}";
  const ok = !!label && !/^select\\s+drug/i.test(text) && (text.includes(code) || title.includes(code) || text.length > 3);
  return { ok, text, title };
})()
`);
      if (result?.ok) {
        committed = true;
        break;
      }
      await sleep(140);
    }
    if (!committed) {
      await clearTargetMarker();
      return { ok: false, error: "Drug selection not committed" };
    }
    
    await sleep(300);
    
    // Step 7: Done - page should auto-fill the rest
    await clearTargetMarker();
    return { ok: true, message: "Drug applied successfully" };
    
  } catch(e) {
    const msgText = String(e?.message || e || "");
    if (msgText.includes("Debugger is not attached to the tab")) {
      return { ok: true, skipped: true, reason: "tab_busy" };
    }
    try {
      await evalValue(tabId, `(() => {
        document.querySelectorAll('[data-wf-fav-target="1"]').forEach(el => el.removeAttribute("data-wf-fav-target"));
        return true;
      })()`);
    } catch (_) {}
    console.error("[applyFavoriteDrugOnPage] Exception:", e?.message);
    return { ok: false, error: e?.message || "Unknown error" };
  }
}

async function closePrescriptionModalOnPage(tabId) {
  return await evalValue(tabId, `
(() => {
  function isVisible(el){
    if(!el) return false;
    const s = getComputedStyle(el);
    if(s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 8 && r.height > 8;
  }

  const modal = [...document.querySelectorAll(".modal-content, .details-modal, .modal.fade.details-modal")]
    .find(el => isVisible(el) && /DRUGS/i.test(el.textContent || ""));

  if (!modal) return { ok: true, closed: true, skipped: true };

  const closeBtn =
    modal.querySelector('button.close[data-dismiss="modal"]') ||
    modal.querySelector("button.close") ||
    modal.querySelector("[data-dismiss='modal']");

  if (!closeBtn) return { ok: false, error: "Close button not found" };
  closeBtn.click();
  return { ok: true, closed: true };
})()
`);
}

async function ensureEmptyDrugRow(tabId, maxTries = 20) {
  for (let i = 0; i < maxTries; i++) {
    const res = await evalValue(tabId, `
(() => {
  function isVisible(el){
    if(!el) return false;
    const s = getComputedStyle(el);
    if(s.display==="none" || s.visibility==="hidden" || s.opacity==="0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 3 && r.height > 3;
  }
  function allDrugScopes() {
    return [...document.querySelectorAll(".auto-complete-wrapper.auto-complete-select-mode, .auto-complete-wrapper, .auto-complete-select-mode")]
      .filter(s => (s.textContent || "").includes("Drug"))
      .filter(isVisible);
  }
  function isEmptyDrugScope(scope) {
    const label = scope?.querySelector(".autocomplete-select-label, .auto-complete-select-label");
    const text = (label?.textContent || "").trim();
    return !text || /^select\\s+drug/i.test(text) || /^select/i.test(text);
  }

  const scopes = allDrugScopes();
  if (scopes.some(isEmptyDrugScope)) return { ok:true, reason:"already_has_empty_row" };

  const hasValidationError = [...document.querySelectorAll(".error-text, .text-danger, .error, .validation-message")]
    .filter(isVisible)
    .some((el) => /please fill the mandatory values|dosage value entered is not allowed|dosage should be a multiple|can't be empty|can not be empty|required|max value must be|not allowed|invalid/i
      .test(String(el.textContent || "").replace(/\\s+/g, " ").trim()));
  if (hasValidationError) return { ok:false, reason:"form_validation_error" };

  const addDoseBtn = [...document.querySelectorAll("button")]
    .filter(isVisible)
    .find((b) => /\\+\\s*Add\\s*Dose/i.test((b.textContent || "").trim()));
  if (!addDoseBtn) return { ok:false, reason:"add_dose_not_found" };
  addDoseBtn.click();
  return { ok:true, reason:"clicked_add_dose" };
})()
`);
    if (res?.ok && res?.reason === "already_has_empty_row") return { ok: true };
    await sleep(220);
  }
  return { ok: false, error: "new_row_timeout" };
}

async function setRefillQueueState(state) {
  await chrome.storage.local.set({ [REFILL_QUEUE_KEY]: state });
}

async function clearRefillQueueState() {
  await chrome.storage.local.remove([REFILL_QUEUE_KEY]);
}

async function getRefillQueueState() {
  const res = await chrome.storage.local.get([REFILL_QUEUE_KEY]);
  return res?.[REFILL_QUEUE_KEY] || null;
}

async function setFavoritesQueueState(state) {
  await chrome.storage.local.set({ [FAVORITES_QUEUE_KEY]: state });
}

async function clearFavoritesQueueState() {
  await chrome.storage.local.remove([FAVORITES_QUEUE_KEY]);
}

async function getFavoritesQueueState() {
  const res = await chrome.storage.local.get([FAVORITES_QUEUE_KEY]);
  return res?.[FAVORITES_QUEUE_KEY] || null;
}

function scheduleRefillAlarm(delayMs) {
  if (!chrome?.alarms?.create) return false;
  chrome.alarms.create(REFILL_ALARM_NAME, { when: Date.now() + Math.max(0, Number(delayMs) || 0) });
  return true;
}

function scheduleFavoritesAlarm(delayMs) {
  if (!chrome?.alarms?.create) return false;
  chrome.alarms.create(FAVORITES_ALARM_NAME, { when: Date.now() + Math.max(0, Number(delayMs) || 0) });
  return true;
}

async function getRefillTiming() {
  const speedMult = await getSpeedMultiplier();
  return {
    busyRetryMs: Math.max(220, Math.round(280 * speedMult)),
    modalCloseWaitMs: Math.max(260, Math.round(330 * speedMult)),
    applyRetryMs: Math.max(360, Math.round(520 * speedMult)),
    nextDrugMs: Math.max(850, Math.round(1100 * speedMult))
  };
}

// ---------- main listener ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    // Handler for GET_PROFILES (doesn't need active tab)
    if (msg?.type === "GET_PROFILES") {
      try {
        const profiles = await getProfiles();
        return sendResponse(profiles);
      } catch(e) {
        return sendResponse({ ok: false, error: e?.message });
      }
    }

    let tabId = Number.isInteger(msg?.targetTabId) ? msg.targetTabId : null;
    if (!tabId) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return sendResponse({ ok: false, error: "No active tab" });
      tabId = tab.id;
    }

    if (msg?.type === "APPLY_FAVORITES_BATCH") {
      const codes = [...new Set(
        (Array.isArray(msg?.drugCodes) ? msg.drugCodes : [])
          .map((x) => String(x || "").trim())
          .filter(Boolean)
      )];

      if (!codes.length) {
        return sendResponse({ ok: false, error: "No favorite drug codes selected" });
      }

      if (refillBatchRunningTabs.has(tabId)) {
        return sendResponse({ ok: false, error: "Refill batch already running on this tab" });
      }

      const existing = await getFavoritesQueueState();
      if (existing?.status === "running") {
        return sendResponse({ ok: false, error: "Favorite batch already running" });
      }

      await setFavoritesQueueState({
        tabId,
        codes,
        index: 0,
        total: codes.length,
        status: "running",
        startedAt: Date.now()
      });

      if (!scheduleFavoritesAlarm(50)) {
        await clearFavoritesQueueState();
        return sendResponse({ ok: false, error: "Alarms API unavailable" });
      }

      return sendResponse({ ok: true, started: true, total: codes.length });
    }

    const needsDebugger =
      msg?.type === "REFILL_BATCH" ||
      msg?.type === "APPLY_FAVORITE" ||
      msg?.type === "EXTRACT_PRESCRIPTION_DRUGS" ||
      msg?.type === "CHECK_PRESCRIPTION_MODAL" ||
      msg?.type === "CLOSE_PRESCRIPTION_MODAL" ||
      msg?.type === "AUTO_FILL" ||
      msg?.type === "TEST_FILL";

    if (needsDebugger && tabDebuggerBusy.has(tabId)) {
      if (msg?.type === "AUTO_FILL") {
        // AUTO_FILL can come while previous fill is still running, especially on slower speeds.
        // Wait briefly instead of dropping it immediately.
        const start = Date.now();
        while (tabDebuggerBusy.has(tabId) && (Date.now() - start) < 4500) {
          await new Promise(r => setTimeout(r, 120));
        }
        if (tabDebuggerBusy.has(tabId)) {
          return sendResponse({ ok: true, skipped: true, reason: "tab_busy" });
        }
      } else {

        // For user-triggered flows (APPLY_FAVORITE/TEST_FILL), wait briefly.
        const start = Date.now();
        while (tabDebuggerBusy.has(tabId) && (Date.now() - start) < 7000) {
          await new Promise(r => setTimeout(r, 120));
        }
        if (tabDebuggerBusy.has(tabId)) {
          return sendResponse({ ok: true, skipped: true, reason: "tab_busy_timeout" });
        }
      }
    }
    if (needsDebugger) tabDebuggerBusy.add(tabId);

    // For handlers that need the debugger, we'll manage attach/detach manually
    let attached = false;
    try {
      if (msg?.type === "EXTRACT_PRESCRIPTION_DRUGS") {
        try {
          await attach(tabId);
          attached = true;
          await send(tabId, "Runtime.enable");

          const drugs = await evalValue(tabId, `
(() => {
  function isVisible(el){
    if(!el) return false;
    const s = getComputedStyle(el);
    if(s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 8 && r.height > 8;
  }

  const modals = [...document.querySelectorAll(".modal-content, .modal-body, .details-modal")]
    .filter(isVisible)
    .filter(el => /DRUGS/i.test(el.textContent || ""));
  if (!modals.length) return { ok:false, error:"Prescription modal not open", drugs:[] };

  const modal = modals
    .map((el) => {
      const txt = String(el.textContent || "");
      const codeCount = (txt.match(/Code:\\s*[0-9\\-]+/ig) || []).length;
      const enCount = el.querySelectorAll("div.english-instruction").length;
      const score = (codeCount * 7) + (enCount * 11) + Math.min(txt.length / 2000, 8);
      return { el, score };
    })
    .sort((a, b) => b.score - a.score)[0]?.el || null;
  if (!modal) return { ok:false, error:"Prescription modal not open", drugs:[] };

  const rowCandidates = [...modal.querySelectorAll(".dhc-table-row.clearfix, .dhc-table-row, .table-row.clearfix, .table-row")]
    .filter(el => /Code:\\s*[0-9\\-]+/i.test(el.textContent || ""));
  const weakNodes = [...modal.querySelectorAll(".drug-name-comp.drug-text-wrapper, .drug-text-wrapper, .dhc-table-cell-container")]
    .filter(el => /Code:\\s*[0-9\\-]+/i.test(el.textContent || ""));
  const rows = [];
  const seenRows = new Set();
  function addRow(node) {
    const r = node?.closest?.(".dhc-table-row.clearfix, .dhc-table-row, .table-row.clearfix, .table-row") || node;
    if (!r || seenRows.has(r)) return;
    seenRows.add(r);
    rows.push(r);
  }
  rowCandidates.forEach(addRow);
  weakNodes.forEach(addRow);

  function cleanName(raw) {
    let x = String(raw || "");
    // If "High alert medication" exists, keep only what comes after it.
    if (/high\\s*alert\\s*medication/i.test(x)) {
      x = x.replace(/^.*?high\\s*alert\\s*medication[:\\s\\-]*/i, "");
    }
    return x
      .replace(/Code:\\s*[0-9\\-]+/ig, " ")
      .replace(/^[^A-Za-z0-9\\u0600-\\u06FF]+/, " ")
      .replace(/[\\r\\n\\t]+/g, " ")
      .replace(/\\s+/g, " ")
      .replace(/^["']+|["']+$/g, "")
      .trim();
  }

  function parseTempProfile(row, nameText, segHint) {
    const rowRoot = row?.closest?.(".dhc-table-row") || row?.closest?.(".table-row") || row?.parentElement || row;
    const rowText = (
      rowRoot?.innerText || rowRoot?.textContent || row?.innerText || row?.textContent || ""
    ).replace(/\\s+/g, " ").trim();
    const segText = String(segHint || "").replace(/\\s+/g, " ").trim();
    const cells = rowRoot?.querySelectorAll?.(".dhc-table-cell") || [];
    const instrCell = cells?.[1] || null;
    const qtyCell = cells?.[2] || null;
    const qtyText = (qtyCell?.textContent || rowText || segText).replace(/\\s+/g, " ").trim();

    const preLine = instrCell?.querySelector?.('span[style*="white-space"]') || null;
    const englishText = (
      preLine?.querySelector?.("div.english-instruction")?.textContent ||
      instrCell?.querySelector?.("div.english-instruction")?.textContent ||
      rowRoot?.querySelector?.("div.english-instruction")?.textContent ||
      ""
    ).replace(/\\s+/g, " ").trim();
    const hasEnglish = !!englishText;
    const hasArabic = !!(preLine?.querySelector?.("div.arabic-instruction"));

    const directSpans = preLine
      ? [...preLine.children].filter((el) => el.tagName === "SPAN")
      : [...(instrCell?.querySelectorAll?.('span[style*="white-space"] > span') || [])];
    const specialToken = directSpans
      .map((el) => (el.textContent || "").replace(/\\s+/g, " ").trim())
      .find((t) => t && !/rout\\s+of\\s+admin|route\\s+of\\s+admin|refills?/i.test(t)) || "";

    const instrText = (
      instrCell?.textContent ||
      preLine?.textContent ||
      ""
    ).replace(/\\s+/g, " ").trim();
    const stdSrc = englishText || specialToken || instrText || rowText || segText;
    const qtyNoLabel = (() => {
      if (!qtyCell) return qtyText;
      const clone = qtyCell.cloneNode(true);
      clone.querySelectorAll(".dhc-table-responsive-label").forEach((el) => el.remove());
      return (clone.textContent || "").replace(/\\s+/g, " ").trim();
    })();

    const extractTimes = (txt) => {
      const t = String(txt || "");
      const mParen = t.match(/([0-9]+)\\s*Time\\(s\\)/i);
      if (mParen?.[1]) return String(mParen[1]);
      const mTimes = t.match(/([0-9]+)\\s*Times?\\b/i);
      if (mTimes?.[1]) return String(mTimes[1]);
      if (/\\bOnce\\b/i.test(t)) return "1";
      if (/\\bTwice\\b/i.test(t)) return "2";
      if (/\\bThrice\\b/i.test(t)) return "3";
      return "";
    };
    const extractEvery = (txt) => {
      const t = String(txt || "");
      const m = t.match(/Every\\s+([0-9]+(?:\\.[0-9]+)?)\\s*(Day(?:\\(s\\)|s)?|Week(?:\\(s\\)|s)?|Month(?:\\(s\\)|s)?)/i);
      if (m?.[1]) return { every: String(m[1]), unit: String(m[2] || "") };
      if (/\\b(?:Once|Twice|Thrice|[0-9]+\\s*Times?)\\s+Daily\\b/i.test(t)) {
        return { every: "1", unit: "Day" };
      }
      return null;
    };
    const extractDuration = (txt) => {
      const t = String(txt || "");
      const mFor =
        t.match(/\\bFor\\s+([0-9]+(?:\\.[0-9]+)?)\\s*(Day(?:\\(s\\)|s)?|Week(?:\\(s\\)|s)?|Month(?:\\(s\\)|s)?)/i) ||
        t.match(/\\bfor\\s+period\\s+of\\s+([0-9]+(?:\\.[0-9]+)?)\\s*(Day(?:\\(s\\)|s)?|Week(?:\\(s\\)|s)?|Month(?:\\(s\\)|s)?)/i);
      if (mFor?.[1]) return { duration: String(mFor[1]), unit: String(mFor[2] || "") };
      return null;
    };

    const take =
      (stdSrc.match(/(?:Take|Inject)\\s+([0-9]+(?:\\.[0-9]+)?)/i) || [])[1] ||
      (String(nameText || "").match(/([0-9]+(?:\\.[0-9]+)?)\\s*(mg|mcg|g|ml|iu|unit)/i) || [])[1] ||
      "";
    const times = extractTimes(stdSrc) || extractTimes(rowText) || "";
    const normalizeUnit = (raw) => {
      const u = String(raw || "").toLowerCase();
      if (u.startsWith("week")) return "Week";
      if (u.startsWith("month")) return "Month";
      return "Day";
    };
    const evObj = extractEvery(stdSrc) || extractEvery(rowText) || extractEvery(segText);
    const durationObj = extractDuration(stdSrc) || extractDuration(rowText) || extractDuration(segText);
    const refills = (
      (preLine?.textContent || rowText || segText).match(/Refills\\s*:?[\\s]*([0-9]+)/i) || []
    )[1] || "";
    const quantitySource = (!hasEnglish && specialToken) ? qtyNoLabel : qtyText;
    const quantity = (
      (quantitySource.match(/([0-9]+(?:\\.[0-9]+)?)/) || [])[1] ||
      (segText.match(/\\bQuantity\\b[^0-9]*([0-9]+(?:\\.[0-9]+)?)/i) || [])[1] ||
      ""
    );

    const isSpecial = !hasEnglish && !hasArabic && !!specialToken;
    const score =
      (durationObj ? 6 : 0) +
      (times ? 3 : 0) +
      (evObj?.every ? 3 : 0) +
      (quantity ? 2 : 0) +
      (take ? 1 : 0) +
      (isSpecial ? 1 : 0);

    return {
      isSpecial,
      specialInstructions: isSpecial ? specialToken : "",
      quantity: String(quantity || "").trim(),
      take: String(take || "").trim(),
      times: String(times || "").trim(),
      every: evObj ? String(evObj.every) : "",
      duration: durationObj ? String(durationObj.duration) : "",
      dayType: evObj ? normalizeUnit(evObj.unit) : (durationObj ? normalizeUnit(durationObj.unit) : "Day"),
      refills: String(refills || "").trim(),
      __score: score
    };
  }

  const map = new Map();
  for (const row of rows) {
    const text = (
      row?.innerText || row?.textContent || ""
    ).replace(/\\s+/g, " ").trim();
    const codeMatch = text.match(/Code:\\s*([0-9\\-]+)/i);
    if (!codeMatch) continue;
    const code = codeMatch[1].trim();

    const generic = row.querySelector(".generic-drug-text");
    let name = cleanName((generic?.textContent || "").replace(/\\s+/g, " ").trim());
    if (!name) {
      name = cleanName(text
        .replace(/Code:\\s*[0-9\\-]+/i, "")
        .split(" [ORAL]")[0]
        .trim());
    }
    if (!name) continue;

    const parsed = parseTempProfile(row, name, text);
    const prev = map.get(code);
    const prevScore = Number(prev?.tempProfile?.__score || 0);
    const curScore = Number(parsed?.__score || 0);
    if (!prev || curScore >= prevScore) {
      map.set(code, { code, name, tempProfile: parsed, __raw: text });
    }
  }

  // Fallback: parse by raw modal text segments per code (resilient when row DOM is inconsistent).
  const modalRawText = String(modal?.innerText || modal?.textContent || "");
  const modalTextNorm = modalRawText.replace(/\\s+/g, " ").trim();
  const escRe = (s) => String(s || "").replace(/[-/\\^$*+?.()|[\]{}]/g, "\\\\$&");
  function segmentForCode(code) {
    const esc = escRe(code);
    const reA = new RegExp("Code\\\\s*:\\\\s*" + esc + "[\\\\s\\\\S]*?(?=\\\\n\\\\s*[^\\\\n]*Code\\\\s*:|$)", "i");
    const mA = modalRawText.match(reA);
    if (mA && mA[0]) return mA[0];
    const reB = new RegExp("Code\\\\s*:\\\\s*" + esc + "[\\\\s\\\\S]*?(?=Code\\\\s*:|$)", "i");
    const mB = modalRawText.match(reB);
    if (mB && mB[0]) return mB[0];
    return "";
  }
  const codeRx = /Code:\\s*([0-9\\-]+)/ig;
  const markers = [];
  let mm;
  while ((mm = codeRx.exec(modalTextNorm)) !== null) {
    markers.push({ code: String(mm[1] || "").trim(), idx: mm.index });
  }
  const segmentByCode = new Map();
  for (let i = 0; i < markers.length; i++) {
    const cur = markers[i];
    const next = markers[i + 1];
    const seg = modalTextNorm.slice(cur.idx, next ? next.idx : modalTextNorm.length);
    const prev = segmentByCode.get(cur.code) || "";
    if (seg.length > prev.length) segmentByCode.set(cur.code, seg);
  }

  for (const [code, item] of map.entries()) {
    const seg = String(segmentForCode(code) || segmentByCode.get(code) || item?.__raw || "");
    if (!seg) continue;
    const tp = item?.tempProfile || {};
    const forM =
      seg.match(/\\bFor\\s+([0-9]+(?:\\.[0-9]+)?)\\s*(Day(?:\\(s\\)|s)?|Week(?:\\(s\\)|s)?|Month(?:\\(s\\)|s)?)/i) ||
      seg.match(/\\bfor\\s+period\\s+of\\s+([0-9]+(?:\\.[0-9]+)?)\\s*(Day(?:\\(s\\)|s)?|Week(?:\\(s\\)|s)?|Month(?:\\(s\\)|s)?)/i);
    if (!String(tp.duration || "").trim()) {
      tp.duration = forM ? String(forM[1]) : "";
    }
    if (!String(tp.dayType || "").trim() && forM?.[2]) {
      const u = String(forM[2] || "").toLowerCase();
      tp.dayType = u.startsWith("week") ? "Week" : (u.startsWith("month") ? "Month" : "Day");
    }
    if (!String(tp.times || "").trim()) {
      const tM = seg.match(/([0-9]+)\\s*Time\\(s\\)/i) || seg.match(/([0-9]+)\\s*Times?\\b/i);
      if (tM?.[1]) {
        tp.times = String(tM[1]);
      } else if (/\\bOnce\\b/i.test(seg)) {
        tp.times = "1";
      } else if (/\\bTwice\\b/i.test(seg)) {
        tp.times = "2";
      } else if (/\\bThrice\\b/i.test(seg)) {
        tp.times = "3";
      }
    }
    if (!String(tp.every || "").trim()) {
      const eM = seg.match(/Every\\s+([0-9]+(?:\\.[0-9]+)?)\\s*(Day(?:\\(s\\)|s)?|Week(?:\\(s\\)|s)?|Month(?:\\(s\\)|s)?)/i);
      if (eM?.[1]) {
        tp.every = String(eM[1]);
      } else if (/\\b(?:Once|Twice|Thrice|[0-9]+\\s*Times?)\\s+Daily\\b/i.test(seg)) {
        tp.every = "1";
      }
      if (!String(tp.dayType || "").trim()) {
        if (eM?.[2]) {
          const u = String(eM[2] || "").toLowerCase();
          tp.dayType = u.startsWith("week") ? "Week" : (u.startsWith("month") ? "Month" : "Day");
        } else if (/\\b(?:Once|Twice|Thrice|[0-9]+\\s*Times?)\\s+Daily\\b/i.test(seg)) {
          tp.dayType = "Day";
        }
      }
    }
    if (!String(tp.quantity || "").trim()) {
      const qM = seg.match(/\\bQuantity\\b[^0-9]*([0-9]+(?:\\.[0-9]+)?)/i);
      if (qM?.[1]) tp.quantity = String(qM[1]);
    }
    if (!String(tp.take || "").trim()) {
      const tkM = seg.match(/(?:Take|Inject)\\s+([0-9]+(?:\\.[0-9]+)?)/i);
      if (tkM?.[1]) tp.take = String(tkM[1]);
    }
    if (!String(tp.refills || "").trim()) {
      const rfM = seg.match(/Refills\\s*:?[\\s]*([0-9]+)/i);
      if (rfM?.[1]) tp.refills = String(rfM[1]);
    }
    item.tempProfile = tp;
  }

  const drugs = [...map.values()].map((item) => {
    const tp = { ...(item?.tempProfile || {}) };
    delete tp.__score;
    return {
      code: item.code,
      name: item.name,
      tempProfile: tp
    };
  });
  return { ok: drugs.length > 0, drugs, error: drugs.length ? \"\" : \"No drugs found\" };
})()
`);

          try {
            if (drugs?.ok && Array.isArray(drugs?.drugs)) {
              queueRefillMetric("extract_result", {
                count: drugs.drugs.length,
                sample: drugs.drugs.slice(0, 12).map((d) => ({
                  code: d?.code || "",
                  duration: d?.tempProfile?.duration || "",
                  take: d?.tempProfile?.take || "",
                  times: d?.tempProfile?.times || "",
                  every: d?.tempProfile?.every || "",
                  quantity: d?.tempProfile?.quantity || "",
                  special: d?.tempProfile?.isSpecial === true
                }))
              });
            } else {
              queueRefillMetric("extract_result_failed", {
                ok: !!drugs?.ok,
                error: drugs?.error || ""
              });
            }
          } catch (_) {}

          await detach(tabId);
          attached = false;
          await flushRefillMetricsNow();
          return sendResponse(drugs);
        } catch (err) {
          if (attached) {
            try { await detach(tabId); } catch(e) {}
            attached = false;
          }
          queueRefillMetric("extract_exception", { error: String(err?.message || err) });
          await flushRefillMetricsNow();
          return sendResponse({ ok:false, error:String(err?.message || err), drugs:[] });
        }
      }

      if (msg?.type === "CHECK_PRESCRIPTION_MODAL") {
        try {
          await attach(tabId);
          attached = true;
          await send(tabId, "Runtime.enable");

          const status = await evalValue(tabId, `
(() => {
  function isVisible(el){
    if(!el) return false;
    const s = getComputedStyle(el);
    if(s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 8 && r.height > 8;
  }

  const modal = [...document.querySelectorAll(".modal-content, .modal-body, .details-modal")]
    .find(el => isVisible(el) && /DRUGS/i.test(el.textContent || ""));

  return { ok:true, available: !!modal };
})()
`);

          await detach(tabId);
          attached = false;
          return sendResponse(status || { ok: true, available: false });
        } catch (err) {
          if (attached) {
            try { await detach(tabId); } catch(e) {}
            attached = false;
          }
          const msgText = String(err?.message || err || "");
          if (msgText.includes("Another debugger is already attached")) {
            return sendResponse({ ok: true, available: false, skipped: true, reason: "tab_busy" });
          }
          return sendResponse({ ok:false, available: false, error: msgText });
        }
      }

      if (msg?.type === "CLOSE_PRESCRIPTION_MODAL") {
        try {
          await attach(tabId);
          attached = true;
          await send(tabId, "Runtime.enable");

          const result = await closePrescriptionModalOnPage(tabId);

          await detach(tabId);
          attached = false;
          return sendResponse(result || { ok: true, closed: true });
        } catch (err) {
          if (attached) {
            try { await detach(tabId); } catch(e) {}
            attached = false;
          }
          const msgText = String(err?.message || err || "");
          if (msgText.includes("Another debugger is already attached")) {
            return sendResponse({ ok: false, error: "Tab is busy, retry refill" });
          }
          return sendResponse({ ok: false, error: msgText });
        }
      }

      if (msg?.type === "REFILL_BATCH") {
        const codes = Array.isArray(msg?.drugCodes) ? msg.drugCodes.map((x) => String(x || "").trim()).filter(Boolean) : [];
        const tempProfileIds = Array.isArray(msg?.tempProfileIds) ? msg.tempProfileIds.map((x) => String(x || "").trim()).filter(Boolean) : [];
        queueRefillMetric("batch_start_request", {
          tabId,
          codes: codes.length,
          tempProfiles: tempProfileIds.length
        });
        if (!codes.length) {
          queueRefillMetric("batch_start_failed", { reason: "no_codes" });
          await flushRefillMetricsNow();
          if (tempProfileIds.length) await removeProfilesByIds(tempProfileIds);
          return sendResponse({ ok: false, error: "No drug codes selected" });
        }

        const existing = await getRefillQueueState();
        if (existing?.status === "running") {
          queueRefillMetric("batch_start_failed", { reason: "already_running" });
          await flushRefillMetricsNow();
          if (tempProfileIds.length) await removeProfilesByIds(tempProfileIds);
          return sendResponse({ ok: false, error: "Refill batch already running" });
        }

        await setRefillQueueState({
          tabId,
          codes,
          tempProfileIds,
          index: 0,
          total: codes.length,
          status: "running",
          startedAt: Date.now()
        });
        queueRefillMetric("batch_started", { tabId, total: codes.length });
        if (!scheduleRefillAlarm(50)) {
          queueRefillMetric("batch_start_failed", { reason: "alarms_unavailable" });
          await flushRefillMetricsNow();
          if (tempProfileIds.length) await removeProfilesByIds(tempProfileIds);
          await clearRefillQueueState();
          return sendResponse({ ok: false, error: "Alarms API unavailable" });
        }
        await flushRefillMetricsNow();
        return sendResponse({ ok: true, started: true, total: codes.length });
      }

      // APPLY_FAVORITE handler
      if (msg?.type === "APPLY_FAVORITE") {
        const drugCode = msg.drugCode || "";
        if (!drugCode) {
          return sendResponse({ ok: false, error: "No drug code" });
        }
        
        try {
          await attach(tabId);
          attached = true;
          
          const res = await applyFavoriteDrugOnPage(tabId, drugCode);
          
          // Detach BEFORE sending response
          await detach(tabId);
          attached = false;
          
          return sendResponse(res);
        } catch (err) {
          const msgText = String(err?.message || err || "");
          if (attached) {
            try { await detach(tabId); } catch(e) {}
            attached = false;
          }
          if (msgText.includes("Another debugger is already attached")) {
            return sendResponse({ ok: true, skipped: true, reason: "tab_busy" });
          }
          console.error(`[Background] Error in APPLY_FAVORITE:`, err);
          return sendResponse({ ok: false, error: msgText });
        }
      }

      // During refill batch, skip content-script AUTO_FILL to avoid debugger races.
      if (msg?.type === "AUTO_FILL") {
        const q = await getRefillQueueState();
        if (q?.status === "running") {
          return sendResponse({ ok: true, skipped: true, reason: "refill_batch_running" });
        }
      }

      // For other handlers that need debugger
      await attach(tabId);
      attached = true;
      await send(tabId, "Runtime.enable");

      const profiles = await getProfiles();
      if (!profiles.length) {
        await detach(tabId);
        attached = false;
        return sendResponse({ ok:false, error:"No profiles saved. Add one in Profiles page." });
      }

      if (msg?.type === "TEST_FILL") {
        const res = await runFillUsingProfile(tabId, profiles[0]);
        res.profile_used = profiles[0];

        const info = await readCurrentDrug(tabId);
        res.drug_code = info.code;
        res.drug_text = info.text;
        res.drug_key  = info.key;

        await detach(tabId);
        attached = false;
        return sendResponse(res);
      }

      if (msg?.type === "AUTO_FILL") {
        // Check if extension is enabled
        const enabledRes = await chrome.storage.local.get(["wasfaty_auto_enabled"]);
        const isEnabled = enabledRes?.wasfaty_auto_enabled ?? true;
        if (!isEnabled) {
          await detach(tabId);
          attached = false;
          return sendResponse({ ok: true, skipped: true, reason: "killed" });
        }

        const info = await readCurrentDrug(tabId);
        const key = info.key || "";

        const now = Date.now();
        // Prevent duplicate AUTO_FILL on same drug caused by rapid DOM mutations after Add/focus.
        if (key && key === lastAutoDrugKey && (now - lastAutoTime) < 4500) {
          await detach(tabId);
          attached = false;
          return sendResponse({ ok: true, skipped: true, reason: "Same drug cooldown" });
        }
        lastAutoDrugKey = key;
        lastAutoTime = now;

        // if both empty -> not ready
        if (!info.code && !info.text) {
          await detach(tabId);
          attached = false;
          return sendResponse({ ok: true, skipped: true, reason: "drug_not_ready" });
        }

        const match = bestProfileMatch(profiles, info);
        if (!match) {
          await detach(tabId);
          attached = false;
          return sendResponse({
            ok: true,
            skipped: true,
            reason: "no_profile_match",
            drug_code: info.code,
            drug_text: info.text
          });
        }

        const res = await runFillUsingProfile(tabId, match);
        res.profile_used = match;
        res.drug_code = info.code;
        res.drug_text = info.text;
        res.drug_key  = info.key;

        await detach(tabId);
        attached = false;
        return sendResponse(res);
      }

      // Unknown message type
      await detach(tabId);
      attached = false;
      return sendResponse({ ok:false, error:"Unknown message type" });
    } catch (e) {
      const msgText = String(e?.message || e || "");
      // Make sure to detach if not already done
      if (attached) {
        try { await detach(tabId); } catch(de) { console.error("Error detaching:", de); }
      }
      if (msgText.includes("Another debugger is already attached")) {
        return sendResponse({ ok: true, skipped: true, reason: "tab_busy" });
      }
      console.error("[Background] Caught error:", e?.message);
      return sendResponse({ ok: false, error: msgText });
    } finally {
      if (needsDebugger) tabDebuggerBusy.delete(tabId);
    }
  })();

  return true;
});

if (chrome?.alarms?.onAlarm?.addListener) chrome.alarms.onAlarm.addListener((alarm) => {
  (async () => {
    if (!alarm) return;

    if (alarm.name === FAVORITES_ALARM_NAME) {
      const state = await getFavoritesQueueState();
      if (!state || state.status !== "running") return;
      const timing = await getRefillTiming();

      const tabId = Number.isInteger(state.tabId) ? state.tabId : null;
      const codes = Array.isArray(state.codes) ? state.codes : [];
      const index = Number(state.index || 0);

      if (!tabId || !codes.length || index >= codes.length) {
        await clearFavoritesQueueState();
        return;
      }

      if (refillBatchRunningTabs.has(tabId) || favoritesBatchRunningTabs.has(tabId) || tabDebuggerBusy.has(tabId)) {
        scheduleFavoritesAlarm(timing.busyRetryMs);
        return;
      }

      favoritesBatchRunningTabs.add(tabId);
      tabDebuggerBusy.add(tabId);
      let attached = false;
      try {
        await attach(tabId);
        attached = true;
        await send(tabId, "Runtime.enable");

        const code = codes[index];
        let success = false;
        let lastErr = "";
        for (let attempt = 0; attempt < 10; attempt++) {
          const r = await applyFavoriteDrugOnPage(tabId, code);
          if (r?.ok && !r?.skipped) {
            success = true;
            break;
          }
          if (r?.ok && r?.skipped && (r?.reason === "tab_busy" || r?.reason === "tab_busy_timeout")) {
            lastErr = r?.reason || "tab_busy";
            await sleep(timing.applyRetryMs);
            continue;
          }
          if (r?.error === "no_empty_row") {
            const rowRes = await ensureEmptyDrugRow(tabId, 12);
            if (!rowRes?.ok) {
              lastErr = rowRes?.error || "new_row_timeout";
              await sleep(timing.applyRetryMs);
              continue;
            }
            await sleep(200);
            continue;
          }
          lastErr = r?.error || "Unknown error";
          await sleep(timing.applyRetryMs);
        }

        if (!success) {
          await setFavoritesQueueState({
            ...state,
            status: "failed",
            error: `Failed on drug ${index + 1}: ${lastErr}`,
            finishedAt: Date.now()
          });
          return;
        }

        const nextIndex = index + 1;
        if (nextIndex >= codes.length) {
          await clearFavoritesQueueState();
          return;
        }

        await setFavoritesQueueState({
          ...state,
          index: nextIndex,
          updatedAt: Date.now()
        });
        scheduleFavoritesAlarm(timing.nextDrugMs);
      } catch (err) {
        await setFavoritesQueueState({
          ...state,
          status: "failed",
          error: String(err?.message || err),
          finishedAt: Date.now()
        });
      } finally {
        if (attached) {
          try { await detach(tabId); } catch (_) {}
        }
        favoritesBatchRunningTabs.delete(tabId);
        tabDebuggerBusy.delete(tabId);
      }
      return;
    }

    if (alarm.name !== REFILL_ALARM_NAME) return;

    const state = await getRefillQueueState();
    if (!state || state.status !== "running") return;
    const timing = await getRefillTiming();

    const tabId = Number.isInteger(state.tabId) ? state.tabId : null;
    const codes = Array.isArray(state.codes) ? state.codes : [];
    const tempProfileIds = Array.isArray(state.tempProfileIds) ? state.tempProfileIds : [];
    const index = Number(state.index || 0);
    queueRefillMetric("alarm_tick", { tabId, index: index + 1, total: codes.length });

    if (!tabId || !codes.length || index >= codes.length) {
      queueRefillMetric("batch_cleanup", { reason: "invalid_state", tabId, index, total: codes.length });
      if (tempProfileIds.length) await removeProfilesByIds(tempProfileIds);
      await clearRefillQueueState();
      await flushRefillMetricsNow();
      return;
    }

    if (refillBatchRunningTabs.has(tabId) || tabDebuggerBusy.has(tabId)) {
      queueRefillMetric("alarm_retry", { reason: "tab_busy", tabId, index: index + 1 });
      scheduleRefillAlarm(timing.busyRetryMs);
      return;
    }

    refillBatchRunningTabs.add(tabId);
    tabDebuggerBusy.add(tabId);
    let attached = false;
    try {
      await attach(tabId);
      attached = true;
      await send(tabId, "Runtime.enable");

      if (index === 0) {
        const closeResult = await closePrescriptionModalOnPage(tabId);
        if (closeResult?.ok === false) {
          queueRefillMetric("step_failed", {
            step: "close_modal",
            index: index + 1,
            code: codes[index],
            reason: closeResult.error || "close_modal_failed"
          });
          if (tempProfileIds.length) await removeProfilesByIds(tempProfileIds);
          await setRefillQueueState({
            ...state,
            status: "failed",
            error: closeResult.error || "Failed to close modal",
            finishedAt: Date.now()
          });
          return;
        }
        await sleep(timing.modalCloseWaitMs);
      }

      const code = codes[index];
      queueRefillMetric("step_start", { index: index + 1, code });

      let success = false;
      let lastErr = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        const t0 = Date.now();
        const r = await applyFavoriteDrugOnPage(tabId, code);
        if (r?.ok && !r?.skipped) {
          queueRefillMetric("apply_ok", {
            index: index + 1,
            code,
            attempt: attempt + 1,
            elapsedMs: Date.now() - t0
          });
          success = true;
          break;
        }
        if (r?.ok && r?.skipped && (r?.reason === "tab_busy" || r?.reason === "tab_busy_timeout")) {
          lastErr = "tab_busy";
          queueRefillMetric("apply_retry", {
            index: index + 1,
            code,
            attempt: attempt + 1,
            reason: r?.reason || "tab_busy"
          });
          await sleep(timing.applyRetryMs);
          continue;
        }
        if (r?.error === "no_results_found") {
          lastErr = "no_results_found";
          queueRefillMetric("step_skipped_candidate", {
            step: "apply_drug_code",
            index: index + 1,
            code,
            reason: "no_results_found"
          });
          break;
        }
        if (r?.error === "no_empty_row") {
          const rowRes = await ensureEmptyDrugRow(tabId, 12);
          queueRefillMetric("row_ensure", {
            index: index + 1,
            code,
            attempt: attempt + 1,
            ok: !!rowRes?.ok,
            reason: rowRes?.reason || rowRes?.error || ""
          });
          if (!rowRes?.ok) {
            lastErr = rowRes?.error || rowRes?.reason || "new_row_timeout";
            if (lastErr === "form_validation_error") {
              queueRefillMetric("apply_retry_blocked", {
                index: index + 1,
                code,
                attempt: attempt + 1,
                reason: "form_validation_error"
              });
              break;
            }
            await sleep(timing.applyRetryMs);
            continue;
          }
        }
        lastErr = r?.error || "Unknown error";
        queueRefillMetric("apply_retry", {
          index: index + 1,
          code,
          attempt: attempt + 1,
          reason: lastErr
        });
        await sleep(timing.applyRetryMs);
      }

      if (!success) {
        if (lastErr === "no_results_found") {
          const nextIndex = index + 1;
          queueRefillMetric("step_skipped", {
            step: "apply_drug_code",
            index: index + 1,
            code,
            reason: "no_results_found",
            nextIndex: nextIndex + 1
          });
          if (nextIndex >= codes.length) {
            queueRefillMetric("batch_completed", { tabId, total: codes.length, skippedLast: true });
            if (tempProfileIds.length) await removeProfilesByIds(tempProfileIds);
            await clearRefillQueueState();
            return;
          }
          await setRefillQueueState({
            ...state,
            index: nextIndex,
            updatedAt: Date.now(),
            skippedLast: { index: index + 1, code, reason: "no_results_found" }
          });
          scheduleRefillAlarm(Math.max(350, Math.round(timing.nextDrugMs * 0.65)));
          return;
        }

        queueRefillMetric("step_failed", {
          step: "apply_drug_code",
          index: index + 1,
          code,
          reason: lastErr || "apply_failed"
        });
        if (tempProfileIds.length) await removeProfilesByIds(tempProfileIds);
        await setRefillQueueState({
          ...state,
          status: "failed",
          error: `Failed on drug ${index + 1}: ${lastErr}`,
          finishedAt: Date.now()
        });
        return;
      }

      // Fill directly here for all selected refill drugs.
      // This avoids 2nd-drug timing misses from AUTO_FILL events.
      const profiles = await getProfiles();
      const matched = findProfileByCode(profiles, code);
      if (!matched) {
        queueRefillMetric("step_failed", {
          step: "profile_match",
          index: index + 1,
          code,
          reason: "profile_not_found"
        });
        if (tempProfileIds.length) await removeProfilesByIds(tempProfileIds);
        await setRefillQueueState({
          ...state,
          status: "failed",
          error: `No profile found for drug ${index + 1}: ${code}`,
          finishedAt: Date.now()
        });
        return;
      }

      const fillProfile = (matched?.data && typeof matched.data === "object")
        ? { ...matched, data: { ...matched.data, clickAdd: true } }
        : { ...matched, clickAdd: true };
      queueRefillMetric("fill_profile_input", {
        index: index + 1,
        code,
        profileName: matched?.name || "",
        profileType: matched?.type || "",
        duration: (fillProfile?.data?.duration ?? fillProfile?.duration ?? ""),
        take: (fillProfile?.data?.take ?? fillProfile?.take ?? ""),
        times: (fillProfile?.data?.times ?? fillProfile?.times ?? ""),
        every: (fillProfile?.data?.every ?? fillProfile?.every ?? ""),
        quantity: (fillProfile?.data?.quantity ?? fillProfile?.quantity ?? ""),
        temp: matched?.__tempRefill === true
      });
      const fillRes = await runFillUsingProfile(tabId, fillProfile);
      try {
        const uiState = await evalValue(tabId, `
(() => {
  const get = (sel) => {
    const el = document.querySelector(sel);
    return el ? String(el.value || "").trim() : "";
  };
  return {
    duration: get('input[name="Duration"]') || get('input[name="For"]'),
    take: get('input[name="UnitPerFrequency"]'),
    times: get('input[name="FrequencyValue"]'),
    every: get('input[name="Every"]') || get('input[name="EveryValue"]'),
    quantity: get('input[name="Quantity"]')
  };
})()
`);
        queueRefillMetric("fill_ui_after", {
          index: index + 1,
          code,
          ok: !!fillRes?.ok,
          mode: fillRes?.mode || "",
          appliedDuration: fillRes?.applied?.Duration ?? fillRes?.applied?.duration ?? false,
          uiDuration: uiState?.duration || "",
          uiTake: uiState?.take || "",
          uiTimes: uiState?.times || "",
          uiEvery: uiState?.every || "",
          uiQuantity: uiState?.quantity || ""
        });
      } catch (_) {}
      if (!fillRes?.ok) {
        queueRefillMetric("step_failed", {
          step: "fill_profile",
          index: index + 1,
          code,
          reason: fillRes?.error || fillRes?.why || "fill_failed"
        });
        if (tempProfileIds.length) await removeProfilesByIds(tempProfileIds);
        await setRefillQueueState({
          ...state,
          status: "failed",
          error: `Fill failed on drug ${index + 1}: ${fillRes?.error || fillRes?.why || "unknown"}`,
          finishedAt: Date.now()
        });
        return;
      }

      const nextIndex = index + 1;
      if (nextIndex >= codes.length) {
        queueRefillMetric("batch_completed", { tabId, total: codes.length });
        if (tempProfileIds.length) await removeProfilesByIds(tempProfileIds);
        await clearRefillQueueState();
        return;
      }

      queueRefillMetric("step_done", { index: index + 1, code, nextIndex: nextIndex + 1 });
      await setRefillQueueState({
        ...state,
        index: nextIndex,
        updatedAt: Date.now()
      });
      scheduleRefillAlarm(timing.nextDrugMs);
    } catch (err) {
      queueRefillMetric("batch_exception", {
        tabId,
        index: index + 1,
        reason: String(err?.message || err)
      });
      if (tempProfileIds.length) await removeProfilesByIds(tempProfileIds);
      await setRefillQueueState({
        ...state,
        status: "failed",
        error: String(err?.message || err),
        finishedAt: Date.now()
      });
    } finally {
      if (attached) {
        try { await detach(tabId); } catch (_) {}
      }
      await flushRefillMetricsNow();
      refillBatchRunningTabs.delete(tabId);
      tabDebuggerBusy.delete(tabId);
    }
  })();
});
