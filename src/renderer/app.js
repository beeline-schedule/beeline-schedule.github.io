import { parseCsv, validateAndNormalize } from "./csv.js";

const state = { config: null, catalog: null, events: [], selectedDate: null, pendingDate: null, timer: null, progressFrame: null, dateScrollFrame: null, language: "ru", pendingLanguage: null, expandedEventId: null, eventPage: 0, listTransitioning: false, swipeStartY: null, suppressClick: false };
const el = id => document.getElementById(id);
const devToolsEnabled = ["127.0.0.1", "localhost"].includes(location.hostname) || new URLSearchParams(location.search).get("dev") === "1";
const PAGE_SIZE = 8;
const DETAIL_WINDOW_SIZE = 6;
const wait = milliseconds => new Promise(resolve => window.setTimeout(resolve, milliseconds));
const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

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
    state.eventPage = initialEventPage();
    bindUi();
    applyConfig();
    render();
    state.timer = window.setInterval(renderStatuses, 1000);
    animateLiveProgress();
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

function localizedDetail(event) {
  return localized(event, "speaker_bio") || localized(event, "description");
}

function nowLabel() { return state.language === "en" ? "NOW" : "СЕЙЧАС"; }

function render() { renderDates(); renderEvents(); renderStatuses(); }

function renderDates({ smooth = false } = {}) {
  const dates = availableDates();
  const nav = el("date-nav");
  const existingDates = [...nav.querySelectorAll("button")].map(button => button.dataset.date);
  if (existingDates.join("|") !== dates.join("|")) {
    nav.innerHTML = dates.map(date => `<button type="button" data-date="${date}"></button>`).join("");
  }
  nav.querySelectorAll("button").forEach(button => {
    const event = state.events.find(item => item.date === button.dataset.date);
    button.textContent = formatDate(button.dataset.date, localized(event, "date_label"));
    button.classList.toggle("active", button.dataset.date === state.selectedDate);
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    bindPressFeedback(button);
    button.addEventListener("click", () => requestDate(button.dataset.date));
  });
  centerActiveDate(smooth);
}

function centerActiveDate(smooth = false) {
  const nav = el("date-nav");
  const buttons = [...nav.querySelectorAll("button")];
  const gap = Number.parseFloat(getComputedStyle(nav).columnGap) || 0;
  const contentWidth = buttons.reduce((total, button) => total + button.offsetWidth, 0) + Math.max(0, buttons.length - 1) * gap;
  const isFourDayForum = state.config.profile === "forum" && buttons.length === 4;
  const allFit = isFourDayForum ? state.language === "ru" : contentWidth <= nav.clientWidth;
  nav.classList.toggle("all-fit", allFit);
  window.cancelAnimationFrame(state.dateScrollFrame);
  if (allFit) {
    nav.scrollLeft = 0;
    return;
  }
  const active = nav.querySelector(".active");
  if (!active) return;
  const target = active.offsetLeft + active.offsetWidth / 2 - nav.clientWidth / 2;
  if (!smooth) {
    nav.scrollLeft = target;
    return;
  }
  const start = nav.scrollLeft;
  const distance = target - start;
  const startedAt = performance.now();
  const duration = 900;
  const step = now => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = progress < .5 ? 4 * progress ** 3 : 1 - ((-2 * progress + 2) ** 3) / 2;
    nav.scrollLeft = start + distance * eased;
    if (progress < 1) state.dateScrollFrame = requestAnimationFrame(step);
  };
  state.dateScrollFrame = requestAnimationFrame(step);
}

function eventsForSelectedDate() { return state.events.filter(event => event.date === state.selectedDate); }

function initialEventPage() {
  const events = eventsForSelectedDate();
  const activeIndex = events.findIndex(event => ["now", "upcoming"].includes(eventStatus(event).name));
  const targetIndex = activeIndex >= 0 ? activeIndex : Math.max(0, events.length - 1);
  return Math.min(targetIndex, Math.max(0, events.length - PAGE_SIZE));
}

function visibleEventWindow(events) {
  const windowSize = state.expandedEventId ? DETAIL_WINDOW_SIZE : PAGE_SIZE;
  const maxOffset = state.expandedEventId ? Math.max(0, events.length - 1) : Math.max(0, events.length - windowSize);
  state.eventPage = Math.max(0, Math.min(state.eventPage, maxOffset));
  const start = state.eventPage;
  return { events: events.slice(start, start + windowSize), start, maxOffset };
}

function bindEventCards(list) {
  list.querySelectorAll(".interactive").forEach(card => {
    bindPressFeedback(card);
    const toggle = () => {
      if (state.suppressClick) return;
      toggleEventDetail(card.dataset.id);
    };
    card.addEventListener("click", toggle);
    card.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); toggle(); } });
  });
}

function detailMarkup(event) {
  const detailText = localizedDetail(event);
  return `<div class="inline-detail ${event.photo ? "" : "no-photo"}">
    ${event.photo ? `<img class="inline-photo" src="${escapeHtml(photoUrl(event.photo))}" alt="">` : ""}
    <div class="inline-copy"><p class="inline-speaker">${escapeHtml(localized(event, "speaker_name"))}</p>${detailText ? `<p class="inline-bio">${escapeHtml(detailText)}</p>` : ""}</div>
  </div>`;
}

async function toggleEventDetail(eventId) {
  if (state.listTransitioning) return;
  const event = state.events.find(item => item.event_id === eventId);
  if (!event) return;
  const currentId = state.expandedEventId;
  if (currentId === eventId) {
    await transitionEventWindow({ nextOffset: state.eventPage, nextExpandedId: null, direction: 1 });
    return;
  }

  const events = eventsForSelectedDate();
  const eventIndex = events.findIndex(item => item.event_id === eventId);
  const visibleIndex = eventIndex - state.eventPage;
  const detailShift = Math.max(0, visibleIndex - (DETAIL_WINDOW_SIZE - 1));
  const nextOffset = Math.min(events.length - 1, state.eventPage + detailShift);
  const currentIndex = currentId ? events.findIndex(item => item.event_id === currentId) : -1;
  const direction = detailShift > 0 || (currentIndex >= 0 && eventIndex > currentIndex) ? 1 : -1;
  await transitionEventWindow({ nextOffset, nextExpandedId: eventId, direction });
}

function bindPressFeedback(node) {
  let pressedAt = 0;
  let releaseTimer = null;
  const release = () => {
    window.clearTimeout(releaseTimer);
    const remaining = Math.max(0, 170 - (performance.now() - pressedAt));
    releaseTimer = window.setTimeout(() => node.classList.remove("is-pressed"), remaining);
  };
  node.addEventListener("pointerdown", () => {
    pressedAt = performance.now();
    node.classList.add("is-pressed");
  });
  node.addEventListener("pointerup", release);
  node.addEventListener("pointercancel", release);
  node.addEventListener("pointerleave", release);
}

function progressGradient(value) {
  const percent = `${(Math.max(0, Math.min(1, value)) * 100).toFixed(3)}%`;
  return `linear-gradient(to right, #fff 0%, #fff ${percent}, #3b3b3b ${percent}, #3b3b3b 100%)`;
}

function renderEvents({ entering = false } = {}) {
  const allEvents = eventsForSelectedDate();
  const windowed = visibleEventWindow(allEvents);
  const events = windowed.events;
  const list = el("schedule-list");
  const stack = el("event-stack");
  list.dataset.position = String(state.eventPage + 1);
  list.dataset.positions = String(windowed.maxOffset + 1);
  list.setAttribute("aria-label", windowed.maxOffset > 0 ? `События ${windowed.start + 1}–${windowed.start + events.length} из ${allEvents.length}` : "События выбранного дня");
  el("empty-state").hidden = allEvents.length > 0;
  stack.innerHTML = events.map((event, index) => {
    const status = eventStatus(event);
    const detailText = localizedDetail(event);
    const interactive = state.config.detailsEnabled && event.detailEnabled !== false && Boolean(detailText || event.photo);
    const expanded = interactive && state.expandedEventId === event.event_id;
    return `<article class="event-card ${status.name} ${interactive ? "interactive" : ""} ${expanded ? "expanded" : ""}" style="--card-index:${index}" data-id="${escapeHtml(event.event_id)}" ${interactive ? `tabindex="0" role="button" aria-expanded="${expanded}"` : ""}>
      <div class="event-body">
        <div class="event-left"><p class="event-type">${escapeHtml(localized(event, "event_type"))}</p><p class="event-time">${escapeHtml(event.start_time)}—${escapeHtml(event.end_time)}</p></div>
        <span class="event-divider"></span>
        <div class="event-right"><p class="event-speaker">${escapeHtml(localized(event, "speaker_name"))}</p><h2>${escapeHtml(localized(event, "title"))}</h2></div>
      </div>
      ${expanded ? detailMarkup(event) : ""}
      <div class="progress-track"></div>
      ${status.name === "now" ? `<div class="now-badge">${nowLabel()} <i></i></div>` : ""}
    </article>`;
  }).join("");
  bindEventCards(stack);
  const cards = [...stack.querySelectorAll(".event-card")];
  cards.forEach((card, index) => {
    const track = card.querySelector(".progress-track");
    track.style.backgroundImage = progressGradient(eventStatus(events[index]).progress);
    card.style.transitionDelay = `${Math.min(index, 6) * 38 + (index * 37 % 43)}ms`;
    if (entering) card.classList.add("is-hidden", "is-preparing");
  });
}

async function transitionList(update) {
  if (state.listTransitioning) return;
  state.listTransitioning = true;
  el("display").classList.add("is-scene-transitioning");
  const list = el("schedule-list");
  const oldCards = [...el("event-stack").querySelectorAll(".event-card")];
  oldCards.forEach((card, index) => {
    card.style.transitionDelay = `${Math.min(index, 7) * 12 + (index * 17 % 23)}ms`;
    card.classList.add("is-hidden");
  });
  await wait(460);
  update();
  renderEvents({ entering: true });
  await paint();
  const newCards = [...el("event-stack").querySelectorAll(".event-card")];
  newCards.forEach((card, index) => { card.style.transitionDelay = `${Math.min(index, 7) * 18}ms`; });
  newCards.forEach(card => card.classList.remove("is-preparing", "is-hidden"));
  await wait(520);
  newCards.forEach(card => { card.style.transitionDelay = ""; });
  el("display").classList.remove("is-scene-transitioning");
  state.listTransitioning = false;
  flushPendingDate();
  flushPendingLanguage();
}

function requestDate(nextDate) {
  if (!availableDates().includes(nextDate)) return;
  if (nextDate === state.selectedDate && !state.listTransitioning) {
    state.pendingDate = null;
    return;
  }
  state.pendingDate = nextDate;
  flushPendingDate();
}

function flushPendingDate() {
  if (state.listTransitioning || !state.pendingDate) return;
  const nextDate = state.pendingDate;
  state.pendingDate = null;
  if (nextDate === state.selectedDate) return;
  void transitionList(() => {
    state.selectedDate = nextDate;
    state.expandedEventId = null;
    state.eventPage = initialEventPage();
    renderDates({ smooth: true });
  });
}

async function transitionEventWindow({ nextOffset, nextExpandedId = state.expandedEventId, direction = 1 }) {
  if (state.listTransitioning) return;
  const events = eventsForSelectedDate();
  const windowSize = nextExpandedId ? DETAIL_WINDOW_SIZE : PAGE_SIZE;
  const maxOffset = nextExpandedId ? Math.max(0, events.length - 1) : Math.max(0, events.length - windowSize);
  nextOffset = Math.max(0, Math.min(maxOffset, nextOffset));
  const oldExpandedId = state.expandedEventId;
  const oldOffset = state.eventPage;
  if (nextOffset === state.eventPage && nextExpandedId === oldExpandedId) return;
  state.listTransitioning = true;
  const display = el("display");
  const switchingDetails = Boolean(oldExpandedId && nextExpandedId && oldExpandedId !== nextExpandedId);
  const pagingOnly = oldExpandedId === nextExpandedId && nextOffset !== oldOffset;
  display.classList.toggle("is-detail-switching", switchingDetails);
  display.classList.toggle("is-wheel-paging", pagingOnly);
  const viewport = el("event-stack").parentElement;
  const viewportRect = viewport.getBoundingClientRect();
  const oldCards = [...el("event-stack").querySelectorAll(".event-card")];
  const eventIndexes = new Map(events.map((event, index) => [event.event_id, index]));
  const oldEventIndexes = oldCards.map(card => eventIndexes.get(card.dataset.id)).filter(Number.isInteger);
  const firstOldEventIndex = oldEventIndexes.length ? Math.min(...oldEventIndexes) : 0;
  const lastOldEventIndex = oldEventIndexes.length ? Math.max(...oldEventIndexes) : -1;
  const oldGeometry = new Map(oldCards.map(card => {
    const rect = card.getBoundingClientRect();
    return [card.dataset.id, { top: rect.top - viewportRect.top, height: rect.height, expanded: card.classList.contains("expanded") }];
  }));

  display.classList.add("is-scene-transitioning");
  state.eventPage = nextOffset;
  state.expandedEventId = nextExpandedId;
  renderEvents();

  const stack = el("event-stack");
  const newCards = [...stack.querySelectorAll(".event-card")];
  const newIds = new Set(newCards.map(card => card.dataset.id));
  const newEventIndexes = newCards.map(card => eventIndexes.get(card.dataset.id)).filter(Number.isInteger);
  const firstNewEventIndex = newEventIndexes.length ? Math.min(...newEventIndexes) : 0;
  const transientDetails = [];
  const ghosts = oldCards.filter(card => !newIds.has(card.dataset.id)).map(exiting => {
    const geometry = oldGeometry.get(exiting.dataset.id);
    const oldIndex = oldCards.indexOf(exiting);
    const exitingEventIndex = eventIndexes.get(exiting.dataset.id);
    const exitDirection = exitingEventIndex < firstNewEventIndex ? 1 : -1;
    const motionIndex = exitDirection > 0 ? oldIndex : oldCards.length - 1 - oldIndex;
    const ghost = exiting.cloneNode(true);
    ghost.classList.remove("is-pressed", "is-overlay", "is-preparing", "wheel-card", "is-entering");
    ghost.classList.add("wheel-ghost");
    ghost.removeAttribute("tabindex");
    ghost.removeAttribute("role");
    ghost.removeAttribute("aria-expanded");
    ghost.style.top = `${geometry.top}px`;
    ghost.style.height = `${geometry.height}px`;
    ghost.style.setProperty("--wheel-exit-tilt", `${exitDirection > 0 ? .5 : -.5}deg`);
    ghost.style.transitionDelay = `${Math.min(motionIndex, 6) * 34}ms`;
    viewport.append(ghost);
    return { node: ghost, geometry, exitDirection };
  });

  newCards.forEach((card, index) => {
    const rect = card.getBoundingClientRect();
    const old = oldGeometry.get(card.dataset.id);
    const cardEventIndex = eventIndexes.get(card.dataset.id);
    const entryDirection = cardEventIndex < firstOldEventIndex ? -1 : cardEventIndex > lastOldEventIndex ? 1 : direction;
    const finalTop = rect.top - viewportRect.top;
    const startY = old ? old.top - finalTop : 0;
    const cardDirection = old ? (startY >= 0 ? 1 : -1) : entryDirection;
    const cardTilt = Math.abs(startY) < .5 ? 0 : cardDirection > 0 ? -.8 : .8;
    card.classList.add("wheel-card", "is-preparing");
    if (!old) card.classList.add("is-entering");
    if (old && old.height !== rect.height) card.style.height = `${old.height}px`;
    if (card.dataset.id === nextExpandedId && oldExpandedId !== nextExpandedId) card.querySelector(".inline-detail")?.classList.add("detail-entering");
    if (old?.expanded && card.dataset.id === oldExpandedId && nextExpandedId !== oldExpandedId) {
      const oldDetail = oldCards.find(item => item.dataset.id === card.dataset.id)?.querySelector(".inline-detail");
      if (oldDetail) {
        const leavingDetail = oldDetail.cloneNode(true);
        leavingDetail.classList.add("detail-leaving");
        card.append(leavingDetail);
        transientDetails.push(leavingDetail);
      }
    }
    card.style.setProperty("--wheel-from", `${startY}px`);
    card.style.setProperty("--wheel-tilt", `${cardTilt}deg`);
    const motionIndex = cardDirection > 0 ? index : newCards.length - 1 - index;
    const staggerDelay = Math.min(motionIndex, 6) * 34;
    const entryDelay = pagingOnly && !old ? 1500 : 0;
    card.style.transitionDelay = `${staggerDelay + entryDelay}ms`;
  });

  await paint();
  newCards.forEach(card => {
    card.classList.remove("is-preparing");
    card.style.removeProperty("height");
  });
  ghosts.forEach(({ node, geometry, exitDirection }) => {
    const safeTravel = Math.min(geometry.height * .3, viewportRect.height * .035);
    node.style.setProperty("--wheel-exit", `${exitDirection > 0 ? -safeTravel : safeTravel}px`);
    node.classList.add("is-leaving");
  });

  await wait(pagingOnly ? 2750 : switchingDetails ? 820 : 1180);
  ghosts.forEach(({ node }) => node.remove());
  transientDetails.forEach(node => node.remove());
  newCards.forEach(card => {
    card.classList.remove("wheel-card", "is-entering");
    card.style.removeProperty("--wheel-from");
    card.style.removeProperty("--wheel-tilt");
    card.style.transitionDelay = "";
  });
  display.classList.remove("is-scene-transitioning");
  display.classList.remove("is-detail-switching");
  display.classList.remove("is-wheel-paging");
  state.listTransitioning = false;
  flushPendingLanguage();
}

async function transitionEventWheel(delta) {
  if (state.listTransitioning) return;
  const events = eventsForSelectedDate();
  const maxOffset = Math.max(0, events.length - PAGE_SIZE);
  const nextOffset = Math.max(0, Math.min(maxOffset, state.eventPage + delta));
  await transitionEventWindow({ nextOffset, nextExpandedId: null, direction: delta });
}

async function transitionLanguage(nextLanguage) {
  if (state.listTransitioning || nextLanguage === state.language) return;
  state.language = nextLanguage;
  updateLanguage();
  updateLocalizedContent();
}

function requestLanguage(nextLanguage) {
  if (!["ru", "en"].includes(nextLanguage)) return;
  if (nextLanguage === state.language) {
    state.pendingLanguage = null;
    return;
  }
  state.pendingLanguage = nextLanguage;
  flushPendingLanguage();
}

function flushPendingLanguage() {
  if (state.listTransitioning || !state.pendingLanguage) return;
  const nextLanguage = state.pendingLanguage;
  state.pendingLanguage = null;
  if (nextLanguage !== state.language) void transitionLanguage(nextLanguage);
}

function updateLocalizedContent() {
  el("date-nav").querySelectorAll("[data-date]").forEach(button => {
    const event = state.events.find(item => item.date === button.dataset.date);
    button.textContent = formatDate(button.dataset.date, localized(event, "date_label"));
  });
  el("schedule-list").querySelectorAll(".event-card").forEach(card => {
    const event = state.events.find(item => item.event_id === card.dataset.id);
    if (!event) return;
    card.querySelector(".event-type").textContent = localized(event, "event_type");
    card.querySelector(".event-speaker").textContent = localized(event, "speaker_name");
    card.querySelector(".event-right h2").textContent = localized(event, "title");
    const detailSpeaker = card.querySelector(".inline-speaker");
    const detailBio = card.querySelector(".inline-bio");
    if (detailSpeaker) detailSpeaker.textContent = localized(event, "speaker_name");
    if (detailBio) detailBio.textContent = localizedDetail(event);
    const badge = card.querySelector(".now-badge");
    if (badge) badge.innerHTML = `${nowLabel()} <i></i>`;
  });
  centerActiveDate(false);
}

function changeEventPage(delta) {
  transitionEventWheel(delta < 0 ? -1 : 1);
}

function renderStatuses() {
  if (state.listTransitioning) return;
  el("schedule-list")?.querySelectorAll(".event-card").forEach(card => {
    const event = state.events.find(item => item.event_id === card.dataset.id);
    if (!event) return;
    const status = eventStatus(event);
    card.classList.remove("past", "now", "upcoming"); card.classList.add(status.name);
    card.querySelector(".progress-track").style.backgroundImage = progressGradient(status.progress);
    const badge = card.querySelector(".now-badge");
    if (status.name === "now" && !badge) card.insertAdjacentHTML("beforeend", `<div class="now-badge">${nowLabel()} <i></i></div>`);
    if (status.name !== "now") badge?.remove();
  });
}

function animateLiveProgress() {
  if (!document.hidden && !state.listTransitioning) {
    el("schedule-list")?.querySelectorAll(".event-card.now").forEach(card => {
      const event = state.events.find(item => item.event_id === card.dataset.id);
      const progress = card.querySelector(".progress-track");
      if (event && progress) progress.style.backgroundImage = progressGradient(eventStatus(event).progress);
    });
  }
  state.progressFrame = requestAnimationFrame(animateLiveProgress);
}

function photoUrl(value) {
  if (/^https?:\/\//i.test(value) || value.startsWith("public/")) return value;
  return `content/${value.replace(/^\/+/, "")}`;
}

function updateBrandLogo() {
  const profile = state.config.profile === "forum" ? "forum" : "business";
  const logo = profile === "business"
    ? "logo-business.svg"
    : state.language === "en" ? "logo-eng-row.svg" : "logo-full.svg";
  el("brand-logo").src = `public/assets/logos/${logo}`;
  el("brand-logo").alt = profile === "business" ? "Билайн бизнес" : state.language === "en" ? "Beeline" : "Билайн";
}

function applyConfig() {
  const profile = state.config.profile === "forum" ? "forum" : "business";
  el("display").dataset.profile = profile;
  el("display").classList.toggle("patterns-on", state.config.patternsEnabled);
  updateBrandLogo();
  el("screen-title").textContent = state.config.title || "ии лекторий";
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
  document.addEventListener("visibilitychange", () => el("display").classList.toggle("is-page-hidden", document.hidden));
  document.addEventListener("keydown", event => {
    if (devToolsEnabled && event.shiftKey && event.key.toLowerCase() === "d") el("dev-panel").hidden = !el("dev-panel").hidden;
    if (event.key === "Escape" && state.expandedEventId) toggleEventDetail(state.expandedEventId);
    if (event.key === "PageDown") { event.preventDefault(); changeEventPage(1); }
    if (event.key === "PageUp") { event.preventDefault(); changeEventPage(-1); }
  });
  el("dev-close").onclick = () => { el("dev-panel").hidden = true; };
  el("schedule-select").onchange = event => { const params = new URLSearchParams(location.search); params.set("schedule", event.target.value); params.delete("profile"); location.search = params.toString(); };
  el("clock-mode").onchange = event => { state.config.clock.mode = event.target.value; el("fixed-time").disabled = event.target.value !== "fixed"; render(); updateDiagnostics(); };
  el("fixed-time").onchange = event => { state.config.clock.fixed = event.target.value; render(); updateDiagnostics(); };
  el("patterns-toggle").onchange = event => { state.config.patternsEnabled = event.target.checked; applyConfig(); };
  el("details-toggle").onchange = event => { state.config.detailsEnabled = event.target.checked; renderEvents(); updateDiagnostics(); };
  el("csv-file").onchange = async event => {
    try { state.events = validateAndNormalize(parseCsv(await event.target.files[0].text())); state.selectedDate = chooseInitialDate(availableDates()); state.expandedEventId = null; state.eventPage = initialEventPage(); render(); updateDiagnostics("CSV загружен без ошибок"); }
    catch (error) { updateDiagnostics(error.message, true); }
  };
  document.querySelectorAll("[data-language]").forEach(button => {
    bindPressFeedback(button);
    button.onclick = () => {
      requestLanguage(button.dataset.language);
    };
  });
  const list = el("schedule-list");
  list.addEventListener("pointerdown", event => { state.swipeStartY = event.clientY; });
  list.addEventListener("pointercancel", () => { state.swipeStartY = null; });
  list.addEventListener("pointerup", event => {
    if (state.swipeStartY === null) return;
    const distance = event.clientY - state.swipeStartY;
    state.swipeStartY = null;
    if (Math.abs(distance) >= 48) {
      state.suppressClick = true;
      changeEventPage(distance < 0 ? 1 : -1);
      window.setTimeout(() => { state.suppressClick = false; }, 350);
    }
  });
  list.addEventListener("wheel", event => {
    if (Math.abs(event.deltaY) < 18) return;
    event.preventDefault();
    changeEventPage(event.deltaY > 0 ? 1 : -1);
  }, { passive: false });
}

function updateLanguage() {
  document.documentElement.lang = state.language;
  updateBrandLogo();
  el("empty-state").textContent = state.language === "en" ? "No events on this date" : "На выбранную дату событий нет";
  document.querySelectorAll("[data-language]").forEach(button => button.classList.toggle("active", button.dataset.language === state.language));
  if (state.config) {
    el("screen-title").textContent = state.config.title || "ии лекторий";
    el("schedule-select").innerHTML = Object.entries(state.config.schedules).map(([id, schedule]) => `<option value="${escapeHtml(id)}">${escapeHtml(localized(schedule, "name") || id)}</option>`).join("");
    el("schedule-select").value = state.config.schedule;
  }
}
function updateDiagnostics(message, error = false) { const node = el("diagnostics"); node.textContent = message || `${state.events.length} событий · ${state.config.clock.mode === "fixed" ? state.config.clock.fixed : "системное время"}`; node.classList.toggle("error", error); }
function toLocalInput(value) { if (!value) return ""; const date = new Date(value); const pad = number => String(number).padStart(2, "0"); return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; }
function escapeHtml(value) { return String(value || "").replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" })[char]); }
function showFatal(error) { el("fatal-error").hidden = false; el("fatal-error").innerHTML = `<h2>Не удалось открыть расписание</h2><pre>${escapeHtml(error.message || error)}</pre>`; }

boot();
