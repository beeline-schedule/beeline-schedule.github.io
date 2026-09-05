const REQUIRED_COLUMNS = ["date", "event_id", "event_order", "start_time", "end_time", "title"];

export function parseCsv(input) {
  const text = String(input).replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  if (quoted) throw new Error("CSV: незакрытая кавычка");
  if (!rows.length) throw new Error("CSV пуст");

  const headers = rows.shift().map(value => value.trim());
  const records = rows
    .filter(values => values.some(value => value.trim() !== ""))
    .map((values, rowIndex) => {
      const record = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
      Object.defineProperty(record, "__row", { value: rowIndex + 2, enumerable: false });
      return record;
    });
  return { headers, records };
}

function bool(value, fallback = false) {
  if (value === "" || value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "да"].includes(normalized)) return true;
  if (["false", "0", "no", "нет"].includes(normalized)) return false;
  return null;
}

export function validateAndNormalize({ headers, records }) {
  const errors = [];
  for (const column of REQUIRED_COLUMNS) if (!headers.includes(column)) errors.push(`Нет обязательной колонки «${column}»`);
  const ids = new Set();
  const orders = new Set();
  const manualNowByDate = new Map();
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

  const events = records.map(record => {
    const prefix = `Строка ${record.__row}`;
    for (const column of REQUIRED_COLUMNS) if (!String(record[column] || "").trim()) errors.push(`${prefix}: пустое поле «${column}»`);
    if (!datePattern.test(record.date)) errors.push(`${prefix}: дата должна быть YYYY-MM-DD`);
    if (!timePattern.test(record.start_time) || !timePattern.test(record.end_time)) errors.push(`${prefix}: время должно быть HH:MM`);
    if (timePattern.test(record.start_time) && timePattern.test(record.end_time) && record.end_time < record.start_time) errors.push(`${prefix}: окончание раньше начала`);
    if (ids.has(record.event_id)) errors.push(`${prefix}: повторяется event_id «${record.event_id}»`);
    ids.add(record.event_id);
    if (!/^\d+$/.test(record.event_order) || Number(record.event_order) < 1) errors.push(`${prefix}: event_order должен быть положительным целым числом`);
    const orderKey = `${record.date}:${record.event_order}`;
    if (orders.has(orderKey)) errors.push(`${prefix}: повторяется event_order ${record.event_order} для ${record.date}`);
    orders.add(orderKey);
    const visible = bool(record.is_visible, true);
    const detailEnabled = bool(record.detail_enabled, true);
    if (visible === null) errors.push(`${prefix}: некорректное is_visible`);
    if (detailEnabled === null) errors.push(`${prefix}: некорректное detail_enabled`);
    if (record.status_override === "now") {
      manualNowByDate.set(record.date, (manualNowByDate.get(record.date) || 0) + 1);
    }
    if (record.status_override && !["now", "past", "upcoming"].includes(record.status_override)) errors.push(`${prefix}: неизвестный status_override`);
    const photo = String(record.photo || "").trim();
    if (photo && !/^https?:\/\//i.test(photo) && (/^[a-z]:[\\/]/i.test(photo) || photo.startsWith("/") || photo.split(/[\\/]/).includes(".."))) {
      errors.push(`${prefix}: photo должен быть относительным безопасным путём или http(s) URL`);
    }
    return {
      ...record,
      eventOrder: Number(record.event_order),
      visible: visible ?? true,
      placeholder: bool(record.is_placeholder, false) ?? false,
      detailEnabled: detailEnabled ?? true,
      description: String(record.description || "").trim(),
      photo
    };
  });
  for (const [date, count] of manualNowByDate) if (count > 1) errors.push(`${date}: status_override=now указан больше одного раза`);
  if (errors.length) throw new Error(errors.slice(0, 12).join("\n"));
  return events.filter(event => event.visible).sort((a, b) => a.date.localeCompare(b.date) || a.eventOrder - b.eventOrder);
}
