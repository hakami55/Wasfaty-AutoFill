const KEY_ENABLED = "wasfaty_auto_enabled";
const KEY_SETTINGS = "wasfaty_settings_v1";
const KEY_FAVORITES = "wasfaty_favorite_drugs";
const KEY_PROFILES = "wasfaty_profiles_v1";

const $ = (id) => document.getElementById(id);
let refillDrugs = [];
let currentTempProfileIds = [];
let allowRefillWithoutProfile = true;
let useTempProfilesForAllRefill = false;
let specialTempDurationMaxValue = "";
let showRefillBoxInPopup = true;

function setStatus(msg, isErr = false) {
  const el = $("status");
  if (!el) return;
  const text = String(msg || "").trim();
  if (!text) {
    el.textContent = "";
    el.classList.add("hidden");
    return;
  }
  el.textContent = text;
  el.style.color = isErr ? "#dc2626" : "#6b7280";
  el.classList.remove("hidden");
}

function isWasfatyUrl(url) {
  return /^https:\/\/[^/]*\.wasfaty\.sa\//i.test(String(url || ""));
}

async function resolveWasfatyTabId() {
  const tabs = await chrome.tabs.query({});
  const hit = tabs.find((t) => t?.id && isWasfatyUrl(t.url));
  return hit?.id || null;
}

async function getSettings() {
  const res = await chrome.storage.local.get([KEY_ENABLED, KEY_SETTINGS]);
  const settings = res[KEY_SETTINGS] || {};
  const allowRefillWithoutProfile = settings.allowRefillWithoutProfile !== false;
  return {
    enabled: res[KEY_ENABLED] ?? true,
    showFavoritesInPopup: settings.showFavoritesInPopup !== false,
    showRefillBoxInPopup: settings.showRefillBoxInPopup !== false,
    allowRefillWithoutProfile,
    useTempProfilesForAllRefill: allowRefillWithoutProfile && settings.useTempProfilesForAllRefill === true,
    specialTempDurationMaxValue: String(settings.specialTempDurationMaxValue ?? "").trim()
  };
}

async function getProfiles() {
  return await chrome.runtime.sendMessage({ type: "GET_PROFILES" });
}

async function getProfileNameByDrugCode(drugCode) {
  try {
    const profiles = await getProfiles();
    const profile = profiles?.find(p => {
      const match = String(p.match || "").trim().toLowerCase();
      const code = String(drugCode || "").trim().toLowerCase();
      return match === code;
    });
    return profile?.name || drugCode;
  } catch {
    return drugCode;
  }
}

async function getFavoriteDrugs() {
  const res = await chrome.storage.local.get([KEY_FAVORITES]);
  return Array.isArray(res[KEY_FAVORITES]) ? res[KEY_FAVORITES] : [];
}

async function getStoredProfiles() {
  const res = await chrome.storage.local.get([KEY_PROFILES]);
  return Array.isArray(res[KEY_PROFILES]) ? res[KEY_PROFILES] : [];
}

async function setStoredProfiles(arr) {
  await chrome.storage.local.set({ [KEY_PROFILES]: Array.isArray(arr) ? arr : [] });
}

async function deleteProfilesByIds(ids) {
  const list = Array.isArray(ids) ? ids.map((x) => String(x || "").trim()).filter(Boolean) : [];
  if (!list.length) return;
  const cur = await getStoredProfiles();
  const keep = cur.filter((p) => !list.includes(String(p?.id || "")));
  await setStoredProfiles(keep);
}

function buildTempProfileForDrug(drug) {
  const t = drug?.tempProfile || {};
  const norm = (v, d = "") => {
    const s = String(v ?? "").trim();
    return s || d;
  };
  const toNum = (v) => {
    const n = Number(String(v ?? "").replace(/[^0-9.]+/g, ""));
    return Number.isFinite(n) ? n : NaN;
  };
  const code = String(drug?.code || "").trim();
  const name = String(drug?.name || code || "Temp Drug").trim();
  const takeFromName = (
    String(name || "").match(/([0-9]+(?:\.[0-9]+)?)\s*(mg|mcg|g|ml|iu|unit)\b/i) || []
  )[1] || "";
  const parsedTake = String(t?.take ?? "").trim();
  const derivedTake = (() => {
    if (parsedTake) return "";
    if (t?.isSpecial) return "";
    const qty = toNum(t?.quantity);
    const duration = toNum(t?.duration);
    const times = toNum(t?.times);
    const every = toNum(t?.every || 1);
    if (!(qty > 0) || !(duration > 0) || !(times > 0) || !(every > 0)) return "";
    const raw = (qty * every) / (duration * times);
    if (!Number.isFinite(raw) || raw <= 0) return "";
    const rounded = Math.round(raw);
    if (Math.abs(raw - rounded) > 0.2) return "";
    if (rounded < 1 || rounded > 1000) return "";
    return String(rounded);
  })();
  // Trust the parsed instruction dose first. For tablet-count drugs,
  // a valid parsed "1" should not be replaced by a strength like "0.2 mg" from the name.
  const resolvedTake = parsedTake || derivedTake || takeFromName || "1";

  // If extraction missed "For X Day(s)", derive duration from quantity/take/times/every.
  const derivedDuration = (() => {
    const direct = String(t?.duration ?? "").trim();
    if (direct) return direct;
    if (t?.isSpecial) return "";
    const qty = toNum(t?.quantity);
    const take = toNum(resolvedTake);
    const times = toNum(t?.times);
    const every = toNum(t?.every || 1);
    if (!(qty > 0) || !(take > 0) || !(times > 0) || !(every > 0)) return "";
    const raw = (qty / (take * times)) * every;
    if (!Number.isFinite(raw) || raw <= 0) return "";
    const rounded = Math.round(raw);
    if (Math.abs(raw - rounded) > 0.2) return "";
    if (rounded < 1 || rounded > 3650) return "";
    return String(rounded);
  })();

  if (t.isSpecial) {
    const extractedDuration = String(t.duration ?? "").trim();
    const fallbackDuration = String(specialTempDurationMaxValue || "").trim();
    const resolvedDuration = extractedDuration || fallbackDuration;
    const manualDuration = !resolvedDuration;
    return {
      id: crypto.randomUUID(),
      name: `[TEMP] ${name}`,
      match: code.toLowerCase(),
      type: "special",
      __tempRefill: true,
      data: {
        specialInstructions: norm(t.specialInstructions, "as directed"),
        quantity: norm(t.quantity, "1"),
        duration: resolvedDuration,
        manualDuration: manualDuration,
        refills: norm(t.refills, "0"),
        clickAdd: true
      }
    };
  }

  return {
    id: crypto.randomUUID(),
    name: `[TEMP] ${name}`,
    match: code.toLowerCase(),
    type: "standard",
    __tempRefill: true,
    data: {
      take: norm(resolvedTake, "1"),
      times: norm(t.times, "1"),
      every: norm(t.every, "1"),
      duration: norm(t.duration || derivedDuration, ""),
      doseTiming: "",
      dayType: norm(t.dayType, "Day"),
      refills: norm(t.refills, "0"),
      clickAdd: true
    }
  };
}

async function createTempProfilesForMissingDrugs(drugs, options = {}) {
  const forceAll = options?.forceAll === true;
  const source = Array.isArray(drugs) ? drugs : [];
  const targets = source.filter((d) => d && (forceAll || d.hasProfile === false));
  if (!targets.length) return [];
  const targetCodes = new Set(
    targets
      .map((d) => String(d?.code || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const cur = await getStoredProfiles();
  // Remove old temp profiles for same code to avoid stale "28" reuse.
  const base = cur.filter((p) => {
    if (p?.__tempRefill !== true) return true;
    const m = String(p?.match || "").trim().toLowerCase();
    return !targetCodes.has(m);
  });
  const add = targets.map(buildTempProfileForDrug);
  await setStoredProfiles([...base, ...add]);
  return add.map((x) => x.id);
}

async function renderFavoriteDrugs() {
  try {
    const settings = await getSettings();
    const favorites = await getFavoriteDrugs();
    const container = $("favoritesList");
    const section = $("favoritesSection");

    if (!settings.showFavoritesInPopup || favorites.length === 0) {
      section.classList.add("hidden");
      return;
    }

    section.classList.remove("hidden");
    container.innerHTML = "";

    for (const drug of favorites) {
      const profileName = await getProfileNameByDrugCode(drug);
      const option = document.createElement("option");
      option.value = drug;
      option.textContent = profileName;
      container.appendChild(option);
    }
  } catch (e) {
    console.error("Error rendering favorites:", e);
  }
}

function initFavoritesSelectToggle() {
  const select = $("favoritesList");
  if (!select) return;

  select.addEventListener("mousedown", (e) => {
    const option = e.target;
    if (!(option instanceof HTMLOptionElement)) return;
    const prevScrollTop = select.scrollTop;
    e.preventDefault();
    option.selected = !option.selected;

    // Keep viewport/focus stable; prevent jump back to first selected option.
    setTimeout(() => {
      try { select.focus({ preventScroll: true }); } catch (_) { select.focus(); }
      select.scrollTop = prevScrollTop;
    }, 0);
  });
}

function initMultiSelectToggle(id) {
  const select = $(id);
  if (!select) return;

  select.addEventListener("mousedown", (e) => {
    const option = e.target;
    if (!(option instanceof HTMLOptionElement)) return;
    const prevScrollTop = select.scrollTop;
    e.preventDefault();
    option.selected = !option.selected;

    setTimeout(() => {
      try { select.focus({ preventScroll: true }); } catch (_) { select.focus(); }
      select.scrollTop = prevScrollTop;
    }, 0);
  });
}

function selectAllInList(selectId) {
  const select = $(selectId);
  if (!select) return 0;
  let selectedCount = 0;
  for (const opt of Array.from(select.options || [])) {
    if (opt.disabled) continue;
    opt.selected = true;
    selectedCount++;
  }
  try { select.focus({ preventScroll: true }); } catch (_) { select.focus(); }
  return selectedCount;
}

function renderRefillList() {
  const list = $("refillList");
  const refillBtn = $("refillNowBtn");
  const panel = $("refillPanel");
  if (!list || !refillBtn) return;
  const canUseTempProfiles = useTempProfilesForAllRefill || allowRefillWithoutProfile;

  list.innerHTML = "";
  for (const item of refillDrugs) {
    const opt = document.createElement("option");
    opt.value = item.code;
    opt.textContent = item.name || "Unknown medication";
    if (item?.hasProfile === false) {
      const isSpecial = item?.tempProfile?.isSpecial === true;
      opt.style.color = isSpecial ? "#e11d48" : "#dc2626"; // special=near-red, standard=red
      opt.style.fontWeight = "700";
      if (!canUseTempProfiles) {
        opt.disabled = true;
        opt.style.opacity = "0.55";
        opt.title = "No saved profile";
      }
    }
    list.appendChild(opt);
  }

  const eligibleCount = refillDrugs.filter((d) => canUseTempProfiles || d?.hasProfile === true).length;
  refillBtn.disabled = eligibleCount === 0;
  if (panel) panel.classList.toggle("hidden", refillDrugs.length === 0);
}

async function checkRefillAvailability() {
  const extractBtn = $("extractRefillBtn");
  if (!extractBtn) return;
  if (!showRefillBoxInPopup) {
    extractBtn.disabled = true;
    return;
  }

  const tabId = await resolveWasfatyTabId();
  if (!tabId) {
    extractBtn.disabled = true;
    return;
  }

  try {
    const res = await chrome.runtime.sendMessage({
      type: "CHECK_PRESCRIPTION_MODAL",
      targetTabId: tabId
    });
    extractBtn.disabled = !(res?.ok && res?.available);
  } catch (_) {
    extractBtn.disabled = true;
  }
}

async function extractRefillFromPrescription() {
  try {
    if (!showRefillBoxInPopup) {
      setStatus("Refill Box is disabled in Profile settings", true);
      return;
    }
    const tabId = await resolveWasfatyTabId();
    if (!tabId) {
      setStatus("No Wasfaty tab found", true);
      return;
    }

    const res = await chrome.runtime.sendMessage({
      type: "EXTRACT_PRESCRIPTION_DRUGS",
      targetTabId: tabId
    });

    if (!res?.ok) {
      if (currentTempProfileIds.length) {
        await deleteProfilesByIds(currentTempProfileIds);
        currentTempProfileIds = [];
      }
      refillDrugs = [];
      renderRefillList();
      setStatus(res?.error || "No prescription drugs found", true);
      return;
    }

    if (currentTempProfileIds.length) {
      await deleteProfilesByIds(currentTempProfileIds);
      currentTempProfileIds = [];
    }

    refillDrugs = Array.isArray(res.drugs) ? res.drugs : [];
    const s = await getSettings();
    allowRefillWithoutProfile = s.allowRefillWithoutProfile !== false;
    useTempProfilesForAllRefill = s.useTempProfilesForAllRefill === true;
    specialTempDurationMaxValue = String(s.specialTempDurationMaxValue || "").trim();

    const profiles = await getProfiles();
    const profileCodes = new Set(
      (Array.isArray(profiles) ? profiles : [])
        .filter((p) => p?.__tempRefill !== true)
        .map((p) => String(p?.match || "").trim().toLowerCase())
        .filter(Boolean)
    );
    refillDrugs = refillDrugs.map((d) => {
      const code = String(d?.code || "").trim().toLowerCase();
      return { ...d, hasProfile: useTempProfilesForAllRefill ? false : profileCodes.has(code) };
    });

    const shouldCreateTemps = useTempProfilesForAllRefill || allowRefillWithoutProfile;
    if (shouldCreateTemps) {
      currentTempProfileIds = await createTempProfilesForMissingDrugs(refillDrugs, {
        forceAll: useTempProfilesForAllRefill
      });
    } else {
      currentTempProfileIds = [];
    }
    renderRefillList();
    const missingCount = refillDrugs.filter((d) => d?.hasProfile === false).length;
    const note = useTempProfilesForAllRefill
      ? ", temp mode: all drugs"
      : ((!allowRefillWithoutProfile && missingCount > 0)
          ? `, blocked ${missingCount} without profile`
          : "");
    setStatus(`Extracted ${refillDrugs.length} drug(s)${note}`);
  } catch (err) {
    if (currentTempProfileIds.length) {
      await deleteProfilesByIds(currentTempProfileIds);
      currentTempProfileIds = [];
    }
    setStatus("Extract failed: " + (err?.message || String(err)), true);
  }
}

async function refillNow() {
  try {
    if (!showRefillBoxInPopup) {
      setStatus("Refill Box is disabled in Profile settings", true);
      return;
    }
    const list = $("refillList");
    const selected = Array.from(list?.selectedOptions || []).map((o) => o.value).filter(Boolean);

    if (!selected.length) {
      setStatus("Select at least one refill drug", true);
      return;
    }

    if (!(useTempProfilesForAllRefill || allowRefillWithoutProfile)) {
      const blocked = refillDrugs.filter((d) => selected.includes(d.code) && d?.hasProfile === false);
      if (blocked.length) {
        setStatus(`Blocked: ${blocked.length} selected drug(s) without saved profile`, true);
        return;
      }
    }

    const tabId = await resolveWasfatyTabId();
    if (!tabId) {
      setStatus("No Wasfaty tab found", true);
      return;
    }

    setStatus(`Starting refill (${selected.length})...`);
    const startRes = await chrome.runtime.sendMessage({
      type: "REFILL_BATCH",
      drugCodes: selected,
      tempProfileIds: currentTempProfileIds,
      targetTabId: tabId
    });
    if (!startRes?.ok) {
      if (currentTempProfileIds.length) {
        await deleteProfilesByIds(currentTempProfileIds);
        currentTempProfileIds = [];
      }
      setStatus(startRes?.error || "Failed to start refill", true);
      return;
    }

    // Hide popup immediately; refill continues in background service worker.
    window.close();
  } catch (err) {
    setStatus("Refill failed: " + (err?.message || String(err)), true);
  }
}

async function applySelectedFavorites() {
  try {
    const selectedDrugs = Array.from($("favoritesList").selectedOptions).map(opt => opt.value);

    if (selectedDrugs.length === 0) {
      setStatus("Select at least one drug", true);
      return;
    }

    const tabId = await resolveWasfatyTabId();
    if (!tabId) {
      setStatus("No Wasfaty tab found", true);
      return;
    }

    setStatus(`Starting favorite batch (${selectedDrugs.length})...`);
    const startRes = await chrome.runtime.sendMessage({
      type: "APPLY_FAVORITES_BATCH",
      drugCodes: selectedDrugs,
      targetTabId: tabId
    });

    if (!startRes?.ok) {
      setStatus(startRes?.error || "Failed to start favorites batch", true);
      return;
    }

    window.close();
  } catch (err) {
    setStatus("Failed: " + (err?.message || String(err)), true);
  }
}

async function openProfiles() {
  const url = chrome.runtime.getURL("profiles.html");
  await chrome.tabs.create({ url });
}

async function sendToBackground(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");

  return await chrome.runtime.sendMessage({ type });
}

(async function init() {
  setStatus("");
  const settings = await getSettings();
  showRefillBoxInPopup = settings.showRefillBoxInPopup !== false;
  allowRefillWithoutProfile = settings.allowRefillWithoutProfile !== false;
  useTempProfilesForAllRefill = settings.useTempProfilesForAllRefill === true;
  specialTempDurationMaxValue = String(settings.specialTempDurationMaxValue || "").trim();
  $("toggleEnabled").checked = settings.enabled;

  await renderFavoriteDrugs();
  const refillSection = $("refillSection");
  if (refillSection) refillSection.classList.toggle("hidden", !showRefillBoxInPopup);
  renderRefillList();
  initFavoritesSelectToggle();
  initMultiSelectToggle("refillList");
  $("extractRefillBtn").addEventListener("click", extractRefillFromPrescription);
  $("refillNowBtn").addEventListener("click", refillNow);
  if (showRefillBoxInPopup) {
    await checkRefillAvailability();
    setInterval(checkRefillAvailability, 2000);
  }

  $("toggleEnabled").addEventListener("change", async (e) => {
    await chrome.storage.local.set({ [KEY_ENABLED]: e.target.checked });
    setStatus(e.target.checked ? "AutoFill enabled" : "AutoFill disabled");
  });

  $("btnProfile").addEventListener("click", openProfiles);
  $("applySelectedBtn").addEventListener("click", applySelectedFavorites);
  $("selectAllFavoritesLink")?.addEventListener("click", (e) => {
    e.preventDefault();
    const n = selectAllInList("favoritesList");
    if (n > 0) setStatus(`Selected ${n} favorite drug(s)`);
    else setStatus("No favorite drugs to select", true);
  });
  $("selectAllRefillLink")?.addEventListener("click", (e) => {
    e.preventDefault();
    const n = selectAllInList("refillList");
    if (n > 0) setStatus(`Selected ${n} refill drug(s)`);
    else setStatus("No refill drugs to select", true);
  });

  $("btnAutoFill").addEventListener("click", async () => {
    try {
      setStatus("Working...");
      const res = await sendToBackground("AUTO_FILL");

      if (res?.skipped && res?.reason === "killed") {
        setStatus("Disabled (Kill switch)", true);
        return;
      }

      if (res?.ok) {
        if (res?.skipped) setStatus("Skipped: " + (res.reason || ""));
        else setStatus("Done");
      } else {
        setStatus(res?.error || "Failed", true);
      }
    } catch (err) {
      setStatus(err?.message || String(err), true);
    }
  });
})();
