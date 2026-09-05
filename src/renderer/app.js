import { parseCsv, validateAndNormalize } from "./csv.js";

const state = { config: null, catalog: null, events: [], selectedDate: null, timer: null, language: "ru", expandedEventId: null };
const el = id => document.getElementById(id);
const devToolsEnabled = ["127.0.0.1", "localhost"].includes(location.hostname) || new URLSearchParams(location.search).get("dev") === "1";

async function boot() {
  try {
    const configResponse = await fetch("content/config.json", { cache: "no-store" });
    if (!configResponse.ok) throw new Error("Не удалось загрузить content/config.json");
    const baseConfig = await configResponse.json();
    const catalogResponse = await fetch(baseConfig.catalog || "content/schedules.json", { cache: "no-store" });
    if (!catalogResponse.ok) throw new Error("Не удалось загрузить каталог расписаний");
    state.catalog = await catalogResponse.json();
    state.config = mergeQueryConfig(baseConfig, state.catalog);
    const csvResponse = await fetch(state.config.dataFile, { cache: "no-store" });
    if (!csvResponse.ok) throw new Error(`Не удалось загрузить ${state.config.dataFile}`);
    state.language = state.config.language || "ru";
    state.events = validateAndNormalize(parseCsv(await csvResponse.text()));
    const dates = availableDates();
    if (!dates.length) throw new Error("В расписании нет видимых событий");
    state.selectedDate = chooseInitialDate(dates);
    bindUi();
    applyConfig();
    render();
    state.timer = window.setInterval(renderStatuses, 1000);
  } catch (error) { showFatal(error); }
}

function mergeQueryConfig(config, catalog) {
  const params = new URLSearchParams(location.search);
  const schedule = params.get("schedule") || config.schedule || catalog.default;
  const preset = catalog.schedules?.[schedule] || catalog.schedules?.[catalog.default];
  if (!preset) throw new Error(`Расписание «${schedule}» не найдено`);
  return {
    ...config,
    ...preset,
    schedule,
    schedules: catalog.schedules,
    dataFile: preset.file,
    profile: params.get("profile") || preset.profile || config.profile || "business",
    title: params.get("title") || preset.title || config.title || "ии лекторий",
    patternsEnabled: params.has("patterns") ? params.get("patterns") !== "0" : preset.patternsEnabled ?? config.patternsEnabled !== false,
    detailsEnabled: params.has("details") ? params.get("details") !== "0" : config.detailsEnabled !== false,
    clock: {
      ...(config.clock || {}),
      mode: params.get("clock") || config.clock?.mode || "system",
      fixed: params.get("at") || config.clock?.fixed
    }
  };
}

function availableDates() { return [...new Set(state.events.map(event => event.date))].sort(); }

function chooseInitialDate(dates) {
  const today = clockParts().date;
  return dates.includes(today) ? today : dates.find(date => date >= today) || dates.at(-1);
}

function clockDate() {
  if (state.config.clock?.mode === "fixed" && state.config.clock.fixed) return new Date(state.config.clock.fixed);
  return new Date();
}

function clockParts() {
  const timezone = state.events[0]?.timezone || "Europe/Moscow";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(clockDate()).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  const seconds = clockDate().getSeconds();
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, seconds: Number(parts.hour) * 3600 + Number(parts.minute) * 60 + seconds };
}

function timeSeconds(value) { const [hour, minute] = value.split(":").map(Number); return hour * 3600 + minute * 60; }

function eventStatus(event) {
  if (event.status_override === "now") return { name: "now", progress: 0.5 };
  if (["past", "upcoming"].includes(event.status_override)) return { name: event.status_override, progress: event.status_override === "past" ? 1 : 0 };
  const now = clockParts();
  if (event.date < now.date) return { name: "past", progress: 1 };
  if (event.date > now.date) return { name: "upcoming", progress: 0 };
  const start = timeSeconds(event.start_time); const end = timeSeconds(event.end_time);
  if (now.seconds < start) return { name: "upcoming", progress: 0 };
  if (now.seconds >= end) return { name: "past", progress: 1 };
  return { name: "now", progress: Math.max(0, Math.min(1, (now.seconds - start) / Math.max(1, end - start))) };
}

function formatDate(date, fallback) {
  if (fallback) return fallback;
  const value = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat(state.language === "en" ? "en-GB" : "ru-RU", { day: "numeric", month: "long", timeZone: "UTC" }).format(value).toUpperCase();
}

function localized(source, key) {
  if (state.language === "en") return String(source?.[`${key}_en`] || source?.[key] || "");
  return String(source?.[key] || "");
}

function nowLabel() { return state.language === "en" ? "NOW" : "СЕЙЧАС"; }

function render() { renderDates(); renderEvents(); renderStatuses(); }

function renderDates() {
  const dates = availableDates();
  el("date-nav").innerHTML = dates.map(date => {
    const event = state.events.find(item => item.date === date);
    return `<button type="button" data-date="${date}" class="${date === state.selectedDate ? "active" : ""}">${escapeHtml(formatDate(date, localized(event, "date_label")))}</button>`;
  }).join("");
  el("date-nav").querySelectorAll("button").forEach(button => button.addEventListener("click", () => { state.selectedDate = button.dataset.date; state.expandedEventId = null; render(); }));
  el("date-nav").querySelector(".active")?.scrollIntoView({ inline: "center", block: "nearest" });
}

function renderEvents() {
  const events = state.events.filter(event => event.date === state.selectedDate);
  const list = el("schedule-list");
  const previousScrollTop = list.scrollTop;
  el("empty-state").hidden = events.length > 0;
  list.innerHTML = events.map(event => {
    const status = eventStatus(event);
    const interactive = state.config.detailsEnabled && event.detailEnabled !== false && Boolean(event.description || event.description_en || event.photo);
    const expanded = interactive && state.expandedEventId === event.event_id;
    return `<article class="event-card ${status.name} ${interactive ? "interactive" : ""} ${expanded ? "expanded" : ""}" data-id="${escapeHtml(event.event_id)}" ${interactive ? `tabindex="0" role="button" aria-expanded="${expanded}"` : ""}>
      <div class="event-body">
        <div class="event-left"><p class="event-type">${escapeHtml(localized(event, "event_type"))}</p><p class="event-time">${escapeHtml(event.start_time)}—${escapeHtml(event.end_time)}</p></div>
        <span class="event-divider"></span>
        <div class="event-right"><p class="event-speaker">${escapeHtml(localized(event, "speaker_name"))}</p><h2>${escapeHtml(localized(event, "title"))}</h2></div>
      </div>
      ${expanded ? `<div class="inline-detail ${event.photo ? "" : "no-photo"}">
        ${event.photo ? `<img class="inline-photo" src="${escapeHtml(photoUrl(event.photo))}" alt="">` : ""}
        <div class="inline-copy"><p class="inline-speaker">${escapeHtml(localized(event, "speaker_name"))}</p>${localized(event, "speaker_bio") ? `<p class="inline-bio">${escapeHtml(localized(event, "speaker_bio"))}</p>` : ""}<p class="inline-description">${escapeHtml(localized(event, "description"))}</p></div>
      </div>` : ""}
      <div class="progress-track"><span style="width:${(status.progress * 100).toFixed(3)}%"></span></div>
      ${status.name === "now" ? `<div class="now-badge">${nowLabel()} <i></i></div>` : ""}
    </article>`;
  }).join("");
  list.querySelectorAll(".interactive").forEach(card => {
    const toggle = () => { state.expandedEventId = state.expandedEventId === card.dataset.id ? null : card.dataset.id; renderEvents(); };
    card.addEventListener("click", toggle);
    card.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); toggle(); } });
  });
  requestAnimationFrame(() => {
    list.scrollTop = previousScrollTop;
    list.querySelector(".expanded")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (!state.expandedEventId && previousScrollTop === 0) list.querySelector(".now")?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

function renderStatuses() {
  el("schedule-list")?.querySelectorAll(".event-card").forEach(card => {
    const event = state.events.find(item => item.event_id === card.dataset.id);
    if (!event) return;
    const status = eventStatus(event);
    card.classList.remove("past", "now", "upcoming"); card.classList.add(status.name);
    card.querySelector(".progress-track span").style.width = `${(status.progress * 100).toFixed(3)}%`;
    const badge = card.querySelector(".now-badge");
    if (status.name === "now" && !badge) card.insertAdjacentHTML("beforeend", `<div class="now-badge">${nowLabel()} <i></i></div>`);
    if (status.name !== "now") badge?.remove();
  });
}

function photoUrl(value) {
  if (/^https?:\/\//i.test(value) || value.startsWith("public/")) return value;
  return `content/${value.replace(/^\/+/, "")}`;
}

function applyConfig() {
  const profile = state.config.profile === "forum" ? "forum" : "business";
  el("display").dataset.profile = profile;
  el("display").classList.toggle("patterns-on", state.config.patternsEnabled);
  const headerLogo = profile === "forum" ? "logo-full.svg" : "logo-business.svg";
  el("brand-logo").src = `public/assets/logos/${headerLogo}`;
  el("screen-title").textContent = localized(state.config, "title") || "ии лекторий";
  el("schedule-select").innerHTML = Object.entries(state.config.schedules).map(([id, schedule]) => `<option value="${escapeHtml(id)}">${escapeHtml(localized(schedule, "name") || id)}</option>`).join("");
  el("schedule-select").value = state.config.schedule;
  el("clock-mode").value = state.config.clock.mode;
  el("fixed-time").value = toLocalInput(state.config.clock.fixed);
  el("fixed-time").disabled = state.config.clock.mode !== "fixed";
  el("patterns-toggle").checked = state.config.patternsEnabled;
  el("details-toggle").checked = state.config.detailsEnabled;
  updateLanguage(); updateDiagnostics();
}

function bindUi() {
  document.addEventListener("keydown", event => {
    if (devToolsEnabled && event.shiftKey && event.key.toLowerCase() === "d") el("dev-panel").hidden = !el("dev-panel").hidden;
    if (event.key === "Escape" && state.expandedEventId) { state.expandedEventId = null; renderEvents(); }
  });
  el("dev-close").onclick = () => { el("dev-panel").hidden = true; };
  el("schedule-select").onchange = event => { const params = new URLSearchParams(location.search); params.set("schedule", event.target.value); params.delete("profile"); location.search = params.toString(); };
  el("clock-mode").onchange = event => { state.config.clock.mode = event.target.value; el("fixed-time").disabled = event.target.value !== "fixed"; render(); updateDiagnostics(); };
  el("fixed-time").onchange = event => { state.config.clock.fixed = event.target.value; render(); updateDiagnostics(); };
  el("patterns-toggle").onchange = event => { state.config.patternsEnabled = event.target.checked; applyConfig(); };
  el("details-toggle").onchange = event => { state.config.detailsEnabled = event.target.checked; renderEvents(); updateDiagnostics(); };
  el("csv-file").onchange = async event => {
    try { state.events = validateAndNormalize(parseCsv(await event.target.files[0].text())); state.selectedDate = chooseInitialDate(availableDates()); render(); updateDiagnostics("CSV загружен без ошибок"); }
    catch (error) { updateDiagnostics(error.message, true); }
  };
  document.querySelectorAll("[data-language]").forEach(button => button.onclick = () => { state.language = button.dataset.language; updateLanguage(); render(); });
}

function updateLanguage() {
  document.documentElement.lang = state.language;
  el("empty-state").textContent = state.language === "en" ? "No events on this date" : "На выбранную дату событий нет";
  document.querySelectorAll("[data-language]").forEach(button => button.classList.toggle("active", button.dataset.language === state.language));
  if (state.config) {
    el("screen-title").textContent = localized(state.config, "title") || "ии лекторий";
    el("schedule-select").innerHTML = Object.entries(state.config.schedules).map(([id, schedule]) => `<option value="${escapeHtml(id)}">${escapeHtml(localized(schedule, "name") || id)}</option>`).join("");
    el("schedule-select").value = state.config.schedule;
  }
}
function updateDiagnostics(message, error = false) { const node = el("diagnostics"); node.textContent = message || `${state.events.length} событий · ${state.config.clock.mode === "fixed" ? state.config.clock.fixed : "системное время"}`; node.classList.toggle("error", error); }
function toLocalInput(value) { if (!value) return ""; const date = new Date(value); const pad = number => String(number).padStart(2, "0"); return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; }
function escapeHtml(value) { return String(value || "").replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" })[char]); }
function showFatal(error) { el("fatal-error").hidden = false; el("fatal-error").innerHTML = `<h2>Не удалось открыть расписание</h2><pre>${escapeHtml(error.message || error)}</pre>`; }

boot();
