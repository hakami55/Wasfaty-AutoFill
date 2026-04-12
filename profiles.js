const KEY = "wasfaty_profiles_v1";
const SETTINGS_KEY = "wasfaty_settings_v1";
const FAVORITES_KEY = "wasfaty_favorite_drugs"; // Separate storage!
const KEY_SPEED = "wasfaty_entry_speed";

const $ = (id) => document.getElementById(id);

let editingId = null;
let profilesCache = [];
let profilesPageSize = 10;
let profilesSortOrder = "asc";
let profilesCurrentPage = 1;
let profilesSearchQuery = "";

const SPECIAL_TEMP_MAX_PLACEHOLDER = "Leave empty for manual duration entry";
const SPECIAL_TEMP_MAX_DISABLED_PLACEHOLDER = "Disabled until Refill Box is ON";

const SPEED_CONFIG = {
  1: { label: "Slow", min: 500, max: 800 },
  2: { label: "Slow-Medium", min: 350, max: 600 },
  3: { label: "Medium", min: 180, max: 350 },
  4: { label: "Medium-Fast", min: 120, max: 250 },
  5: { label: "Fast", min: 50, max: 150 }
};

function clampSpeed(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, Math.round(n)));
}

function updateProfileSpeedDisplay(speed) {
  const s = SPEED_CONFIG[clampSpeed(speed)] || SPEED_CONFIG[3];
  if ($("profileSpeedValue")) $("profileSpeedValue").textContent = s.label;
  if ($("profileSpeedDetails")) $("profileSpeedDetails").textContent = `Min: ${s.min}ms | Max: ${s.max}ms`;
}

function syncRefillSettingsUI() {
  const refillToggle = $("refillBoxToggle");
  const allowToggle = $("allowRefillNoProfileToggle");
  const forceTempAllToggle = $("useTempProfilesForAllRefillToggle");
  const maxInput = $("specialTempDurationMaxValue");
  const allowRow = $("refillWithoutProfileRow");
  const forceTempAllRow = $("refillUseTempAllRow");
  const maxRow = $("specialTempDurationRow");
  if (!refillToggle || !allowToggle || !forceTempAllToggle || !maxInput) return;

  const refillEnabled = !!refillToggle.checked;
  allowToggle.disabled = !refillEnabled;
  const allowEnabled = refillEnabled && !!allowToggle.checked;
  forceTempAllToggle.disabled = !allowEnabled;
  if (!allowEnabled) forceTempAllToggle.checked = false;
  if (allowRow) allowRow.classList.toggle("is-disabled", !refillEnabled);
  if (forceTempAllRow) forceTempAllRow.classList.toggle("is-disabled", !allowEnabled);

  const maxEnabled = allowEnabled;
  maxInput.disabled = !maxEnabled;
  maxInput.placeholder = maxEnabled
    ? SPECIAL_TEMP_MAX_PLACEHOLDER
    : SPECIAL_TEMP_MAX_DISABLED_PLACEHOLDER;
  if (maxRow) maxRow.classList.toggle("is-disabled", !maxEnabled);
}

function setFormStatus(msg){ $("formStatus").textContent = msg || ""; }
function setAutoDetectStatus(msg){ $("autoDetectStatus").textContent = msg || ""; }
function setFavoritesStatus(msg){ const el = $("favoriteDrugsStatus"); if(el) el.textContent = msg || ""; }
function setDrugCountStatus(count){
  const el = $("drugCountStatus");
  if (el) el.textContent = `Drug count: ${Number(count) || 0}`;
}

function escapeHtml(s){
  return String(s||"").replace(/[&<>"']/g, (c)=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

function showTypeUI(type){
  const isSpecial = type === "special";
  $("specialBox").classList.toggle("hidden", !isSpecial);
  $("standardBox").classList.toggle("hidden", isSpecial);
}

function normalizeMatch(s){
  return String(s||"").trim().toLowerCase();
}

/* -------- storage helpers -------- */
async function getProfilesRaw(){
  const res = await chrome.storage.local.get([KEY]);
  return Array.isArray(res[KEY]) ? res[KEY] : [];
}
async function setProfiles(arr){
  await chrome.storage.local.set({ [KEY]: arr });
}

/* Migration:
   - old standard profiles were flat (take/times/..)
   - new shape is {type, data:{...}} but we allow both
*/
function migrateOne(p){
  if (!p || typeof p !== "object") return null;

  // already new style
  if (p.type && p.data && typeof p.data === "object") return p;

  // old style -> convert to standard
  return {
    id: p.id || crypto.randomUUID(),
    name: p.name || "",
    match: normalizeMatch(p.match),
    type: "standard",
    data: {
      take: p.take ?? "",
      times: p.times ?? "",
      every: p.every ?? "",
      duration: p.duration ?? "",
      doseTiming: p.doseTiming ?? "",
      dayType: p.dayType ?? "",
      refills: p.refills ?? "",
      clickAdd: !!p.clickAdd
    }
  };
}

async function getProfiles(){
  const raw = await getProfilesRaw();
  const migrated = raw.map(migrateOne).filter(Boolean);

  // إذا حصل تحويل، خزنه مرة واحدة
  const changed = JSON.stringify(raw) !== JSON.stringify(migrated);
  if (changed) await setProfiles(migrated);

  return migrated;
}

/* -------- favorite drugs (SEPARATE STORAGE) -------- */
async function getFavoriteDrugs() {
  const res = await chrome.storage.local.get([FAVORITES_KEY]);
  return Array.isArray(res[FAVORITES_KEY]) ? res[FAVORITES_KEY] : [];
}

async function setFavoriteDrugs(arr) {
  await chrome.storage.local.set({ [FAVORITES_KEY]: arr });
}

async function addFavoriteDrug(drugCode) {
  const favorites = await getFavoriteDrugs();
  if (!favorites.includes(drugCode)) {
    favorites.push(drugCode);
    if (favorites.length > 10) favorites.shift(); // Keep only 10
    await setFavoriteDrugs(favorites);
  }
}

async function removeFavoriteDrug(drugCode) {
  const favorites = await getFavoriteDrugs();
  const filtered = favorites.filter(d => d !== drugCode);
  await setFavoriteDrugs(filtered);
}

async function clearFavoriteDrugs() {
  await setFavoriteDrugs([]);
}

async function renderFavoriteDrugsUI() {
  try {
    const res = await chrome.storage.local.get([KEY]);
    const profiles = Array.isArray(res[KEY]) ? res[KEY] : [];
    
    // Get all unique drug codes from profiles, with their profile names
    const drugMap = {}; // { drugCode: profileName }
    profiles.forEach(p => {
      if (p.match) {
        const normalized = normalizeMatch(p.match);
        if (!drugMap[normalized]) {
          drugMap[normalized] = p.name || normalized;
        }
      }
    });
    
    const drugArray = Object.keys(drugMap).sort();
    const favorites = await getFavoriteDrugs();
    
    const container = $("favoriteDrugsList");
    if (!container) return;
    
    container.innerHTML = "";
    
    for (const drug of drugArray) {
      const profileName = drugMap[drug];
      const isChecked = favorites.includes(drug);
      const isDisabled = !isChecked && favorites.length >= 10;
      
      const div = document.createElement("div");
      div.className = "favoriteDrugItem" + (isChecked ? " checked" : "");
      
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = isChecked;
      checkbox.disabled = isDisabled;
      checkbox.dataset.drug = drug;
      
      checkbox.addEventListener("change", async (e) => {
        if (e.target.checked) {
          await addFavoriteDrug(drug);
        } else {
          await removeFavoriteDrug(drug);
        }
        await renderFavoriteDrugsUI();
      });
      
      div.appendChild(checkbox);
      const label = document.createElement("span");
      label.style.flex = "1";
      label.textContent = profileName;
      div.appendChild(label);
      
      container.appendChild(div);
    }
    
    const fav = await getFavoriteDrugs();
    setFavoritesStatus(`Selected: ${fav.length}/10 favorites`);
  } catch(e) {
    console.error("Error rendering favorites:", e);
  }
}

/* -------- form -------- */
function readForm(){
  const type = $("profileType").value;

  const base = {
    id: editingId || crypto.randomUUID(),
    name: $("name").value.trim(),
    match: normalizeMatch($("match").value),
    type
  };

  if (type === "special"){
    return {
      ...base,
      data: {
        specialInstructions: $("specialInstructions").value.trim(),
        quantity: $("quantity").value.trim(),
        duration: $("durationSpecial").value.trim(),
        refills: $("refillsSpecial").value.trim(),
        clickAdd: $("clickAddSpecial").checked
      }
    };
  }

  return {
    ...base,
    data: {
      take: $("take").value.trim(),
      times: $("times").value.trim(),
      every: $("every").value.trim(),
      duration: $("duration").value.trim(),
      doseTiming: ($("doseTiming").value || "").trim(),
      dayType: ($("dayType").value || "").trim(),
      refills: $("refills").value.trim(),
      clickAdd: $("clickAdd").checked
    }
  };
}

function fillForm(p){
  editingId = p.id;
  $("editId").value = p.id;

  $("name").value = p.name || "";
  $("match").value = p.match || "";
  $("profileType").value = p.type || "standard";
  showTypeUI($("profileType").value);

  if (p.type === "special"){
    $("specialInstructions").value = p.data?.specialInstructions || "";
    $("quantity").value = p.data?.quantity || "";
    $("durationSpecial").value = p.data?.duration || "";
    $("refillsSpecial").value = p.data?.refills || "";
    $("clickAddSpecial").checked = !!p.data?.clickAdd;
  } else {
    $("take").value = p.data?.take || "";
    $("times").value = p.data?.times || "";
    $("every").value = p.data?.every || "";
    $("duration").value = p.data?.duration || "";
    $("doseTiming").value = p.data?.doseTiming || "";
    $("dayType").value = p.data?.dayType || "";
    $("refills").value = p.data?.refills || "";
    $("clickAdd").checked = !!p.data?.clickAdd;
  }

  setFormStatus("Editing: " + (p.name || p.id));
}

function resetForm(){
  editingId = null;
  $("editId").value = "";

  ["name","match","take","times","every","duration","refills",
   "specialInstructions","quantity","durationSpecial","refillsSpecial"].forEach(id => $(id).value = "");

  $("doseTiming").value = "";
  $("dayType").value = "";

  $("clickAdd").checked = false;
  $("clickAddSpecial").checked = false;

  $("profileType").value = "standard";
  showTypeUI("standard");

  setFormStatus("Ready");
}

/* -------- table -------- */
function summary(p){
  if (p.type === "special"){
    const d = p.data || {};
    const instr = (d.specialInstructions || "").slice(0, 22);
    return `Instr:"${instr}${(d.specialInstructions||"").length>22?"…":""}" | Qty:${d.quantity||""} | Dur:${d.duration||""} | Ref:${d.refills||""}`;
  }
  const d = p.data || {};
  return `Take:${d.take||""} Times:${d.times||""} Every:${d.every||""} For:${d.duration||""} Dose:${d.doseTiming||""} Day:${d.dayType||""} Ref:${d.refills||""}`;
}

function compareProfileName(a, b){
  const an = String(a?.name || "").trim().toLowerCase();
  const bn = String(b?.name || "").trim().toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

function renderTable(arr){
  profilesCache = Array.isArray(arr) ? arr.slice() : [];
  const tbody = $("table").querySelector("tbody");
  tbody.innerHTML = "";

  const sorted = profilesCache.slice().sort((a, b) => {
    const base = compareProfileName(a, b);
    return profilesSortOrder === "desc" ? -base : base;
  });
  const needle = String(profilesSearchQuery || "").trim().toLowerCase();
  const filtered = !needle ? sorted : sorted.filter((p) => {
    const hay = [
      p?.name || "",
      p?.match || "",
      p?.type || "",
      summary(p)
    ].join(" ").toLowerCase();
    return hay.includes(needle);
  });

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / profilesPageSize));
  profilesCurrentPage = Math.min(Math.max(1, profilesCurrentPage), totalPages);
  const start = (profilesCurrentPage - 1) * profilesPageSize;
  const pageRows = filtered.slice(start, start + profilesPageSize);

  if (!pageRows.length){
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6" class="hint">No profiles found.</td>`;
    tbody.appendChild(tr);
  }

  for (const p of pageRows){
    const tr = document.createElement("tr");
    const add = p.data?.clickAdd ? "Yes" : "No";

    tr.innerHTML = `
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.match)}</td>
      <td>${escapeHtml(p.type || "standard")}</td>
      <td>${escapeHtml(summary(p))}</td>
      <td>${add}</td>
      <td>
        <div class="tableActions">
          <button data-act="edit" data-id="${p.id}" class="iconBtn edit" type="button" title="Edit profile" aria-label="Edit profile">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 20h4l10.5-10.5a1.4 1.4 0 0 0 0-2L16.5 5a1.4 1.4 0 0 0-2 0L4 15.5V20Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M13.5 6.5 18 11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </button>
          <button data-act="del" data-id="${p.id}" class="iconBtn delete" type="button" title="Delete profile" aria-label="Delete profile">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 7h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              <path d="M9 7V5h6v2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M7 7l1 12h8l1-12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M10 11v5M14 11v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }

  if ($("profilesPageInfo")) {
    $("profilesPageInfo").textContent = `Page ${profilesCurrentPage} of ${totalPages}`;
  }
  if ($("profilesPrevPage")) {
    $("profilesPrevPage").disabled = profilesCurrentPage <= 1;
  }
  if ($("profilesNextPage")) {
    $("profilesNextPage").disabled = profilesCurrentPage >= totalPages;
  }

  tbody.querySelectorAll("button").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const id = btn.dataset.id;
      const act = btn.dataset.act;

      if (act === "edit"){
        const arr2 = await getProfiles();
        const p = arr2.find(x=>x.id===id);
        if (p) fillForm(p);
      }

      if (act === "del"){
        if (!confirm("Delete this profile?")) return;
        const arr2 = await getProfiles();
        await setProfiles(arr2.filter(x=>x.id!==id));
        await refresh();
        if (editingId === id) resetForm();
      }
    });
  });
}

async function refresh(){
  const arr = await getProfiles();
  renderTable(arr);
  setDrugCountStatus(arr.length);
  await renderFavoriteDrugsUI();
}

function initProfilesTableControls(){
  if ($("profilesPerPage")) {
    $("profilesPerPage").value = String(profilesPageSize);
    $("profilesPerPage").addEventListener("change", (e) => {
      profilesPageSize = Math.max(1, Number(e.target.value) || 10);
      profilesCurrentPage = 1;
      renderTable(profilesCache);
    });
  }

  if ($("profilesSortOrder")) {
    $("profilesSortOrder").value = profilesSortOrder;
    $("profilesSortOrder").addEventListener("change", (e) => {
      profilesSortOrder = e.target.value === "desc" ? "desc" : "asc";
      profilesCurrentPage = 1;
      renderTable(profilesCache);
    });
  }

  if ($("profilesSearch")) {
    $("profilesSearch").value = profilesSearchQuery;
    $("profilesSearch").addEventListener("input", (e) => {
      profilesSearchQuery = String(e.target.value || "");
      profilesCurrentPage = 1;
      renderTable(profilesCache);
    });
  }

  if ($("profilesPrevPage")) {
    $("profilesPrevPage").addEventListener("click", () => {
      profilesCurrentPage = Math.max(1, profilesCurrentPage - 1);
      renderTable(profilesCache);
    });
  }

  if ($("profilesNextPage")) {
    $("profilesNextPage").addEventListener("click", () => {
      profilesCurrentPage += 1;
      renderTable(profilesCache);
    });
  }
}

/* -------- settings -------- */
async function getSettings(){
  const res = await chrome.storage.local.get([SETTINGS_KEY]);
  const s = res[SETTINGS_KEY] || {};
  const allowRefillWithoutProfile = s.allowRefillWithoutProfile !== false;
  return {
    autoDetect: !!s.autoDetect,
    autoFocusNextDrug: s.autoFocusNextDrug !== false,
    showFavoritesInPopup: s.showFavoritesInPopup !== false,
    showRefillBoxInPopup: s.showRefillBoxInPopup !== false,
    allowRefillWithoutProfile,
    useTempProfilesForAllRefill: allowRefillWithoutProfile && s.useTempProfilesForAllRefill === true,
    specialTempDurationMaxValue: String(s.specialTempDurationMaxValue ?? "").trim()
  };
}
async function setSettings(s){
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
}

async function initSettingsUI(){
  const s = await getSettings();
  const speedRes = await chrome.storage.local.get([KEY_SPEED]);
  const speed = clampSpeed(speedRes?.[KEY_SPEED] ?? 3);
  $("autoDetectToggle").checked = !!s.autoDetect;
  $("autoFocusToggle").checked = s.autoFocusNextDrug !== false;
  $("showFavoritesInPopupToggle").checked = s.showFavoritesInPopup !== false;
  $("refillBoxToggle").checked = s.showRefillBoxInPopup !== false;
  $("allowRefillNoProfileToggle").checked = s.allowRefillWithoutProfile !== false;
  $("useTempProfilesForAllRefillToggle").checked = s.useTempProfilesForAllRefill === true;
  if ($("specialTempDurationMaxValue")) {
    $("specialTempDurationMaxValue").value = s.specialTempDurationMaxValue || "";
  }
  if ($("profileSpeedSlider")) $("profileSpeedSlider").value = String(speed);
  updateProfileSpeedDisplay(speed);
  syncRefillSettingsUI();

  $("refillBoxToggle").addEventListener("change", syncRefillSettingsUI);
  $("allowRefillNoProfileToggle").addEventListener("change", syncRefillSettingsUI);
  if ($("profileSpeedSlider")) {
    $("profileSpeedSlider").addEventListener("input", (e) => {
      updateProfileSpeedDisplay(clampSpeed(e.target.value));
    });
  }
  setAutoDetectStatus(s.autoDetect ? "✅ Auto Detect is ON" : "⛔ Auto Detect is OFF");

  $("saveSettings").addEventListener("click", async ()=>{
    const speedToSave = clampSpeed($("profileSpeedSlider")?.value ?? 3);
    await setSettings({ 
      autoDetect: $("autoDetectToggle").checked,
      autoFocusNextDrug: $("autoFocusToggle").checked,
      showFavoritesInPopup: $("showFavoritesInPopupToggle").checked,
      showRefillBoxInPopup: $("refillBoxToggle").checked,
      allowRefillWithoutProfile: $("allowRefillNoProfileToggle").checked,
      useTempProfilesForAllRefill: $("allowRefillNoProfileToggle").checked && $("useTempProfilesForAllRefillToggle").checked,
      specialTempDurationMaxValue: String($("specialTempDurationMaxValue")?.value || "").trim()
    });
    await chrome.storage.local.set({ [KEY_SPEED]: speedToSave });
    setAutoDetectStatus("✅ Settings Saved");
    $("saveSettings").textContent = "Saved ✓";
    setTimeout(()=> $("saveSettings").textContent="Save Settings", 1200);
  });
}
/* -------- buttons -------- */
$("profileType").addEventListener("change", ()=> showTypeUI($("profileType").value));

$("save").addEventListener("click", async ()=>{
  try{
    const p = readForm();
    if (!p.name) return setFormStatus("❌ Name required");
    if (!p.match) return setFormStatus("❌ Match text required");

    const arr = await getProfiles();
    const idx = arr.findIndex(x=>x.id===p.id);

    if (idx >= 0) arr[idx] = p;
    else arr.push(p);

    await setProfiles(arr);
    await refresh();
    setFormStatus("✅ Saved");
    resetForm();
    
    // Auto-focus on drug filter input for next entry
    const s = await getSettings();
    if (s.autoFocusNextDrug) {
      setTimeout(() => {
        // Find and click the drug selector to open dropdown
        const drugSelector = document.querySelector('[data-stateportionname="DrugName"] .autocomplete-select-label') ||
                            document.querySelector('.auto-complete-select-label') ||
                            $("drugLabel");
        
        if (drugSelector) {
          drugSelector.click();
          
          // Wait for dropdown panel to appear and focus filter input
          setTimeout(() => {
            const filterInput = document.querySelector('[data-stateportionname="DrugName"] .filter-search') ||
                               document.querySelector('.auto-complete-wrapper .search-input') ||
                               document.querySelector('.auto-complete-wrapper input[placeholder*="Filter"]') ||
                               document.querySelector('input[placeholder*="Filter"]');
            
            if (filterInput) {
              filterInput.focus();
              filterInput.select();
            } else {
              // Fallback: just focus on the match field
              $("match").focus();
            }
          }, 200);
        } else {
          $("match").focus();
        }
      }, 300);
    }
  } catch(e){
    console.error(e);
    setFormStatus("❌ Save error: " + (e?.message || e));
  }
});

$("reset").addEventListener("click", resetForm);
$("refresh").addEventListener("click", refresh);
if ($("deselectAllFavoritesLink")) {
  $("deselectAllFavoritesLink").addEventListener("click", async (e) => {
    e.preventDefault();
    await clearFavoriteDrugs();
    await renderFavoriteDrugsUI();
    setFavoritesStatus("Selected: 0/10 favorites");
  });
}

$("export").addEventListener("click", async ()=>{
  const arr = await getProfiles();
  // ✅ Download instead of showing in page
  downloadJsonFile("wasfaty_profiles.json", arr);
  // Optional: show small message in the box
  $("exportBox").textContent = "✅ Download started: wasfaty_profiles.json";
});

$("import").addEventListener("click", async ()=>{
  const file = $("importFile").files?.[0];
  if (!file) return setFormStatus("❌ Choose a JSON file first");

  try{
    const text = await file.text();
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error("JSON must be an array");

    const cleaned = arr.map(migrateOne).filter(Boolean);
    await setProfiles(cleaned);
    await refresh();
    setFormStatus("✅ Imported");
  }catch(e){
    setFormStatus("❌ Import error: " + e.message);
  }
});

$("clearAll").addEventListener("click", async ()=>{
  if (!confirm("⚠️ Delete ALL profiles permanently?")) return;
  await chrome.storage.local.remove([KEY]);
  await refresh();
  resetForm();
  setFormStatus("✅ All profiles deleted");
});

/* -------- boot -------- */
(async function boot(){
  showTypeUI($("profileType").value);
  initProfilesTableControls();
  await initSettingsUI();
  await refresh();
  resetForm();
})();

function downloadJsonFile(filename, obj) {
  const json = JSON.stringify(obj, null, 2);
  const blob = new Blob([json], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();

  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}



