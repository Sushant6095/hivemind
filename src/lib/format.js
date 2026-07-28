export function timeAgo(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

export function money(amount, currency = "INR") {
  const sym = currency === "INR" ? "₹" : `${currency} `;
  return `${sym}${Number(amount ?? 0).toLocaleString("en-IN")}`;
}

// Deep-link a compiled record back to its source Telegram message.
// Supergroup ids start with "-100"; strip it for the t.me/c/ path. Plain groups
// (no "-100") and demo spaces can't be deep-linked → return null (hide the link).
export function tgSourceLink(space, msgIds) {
  const chatId = space?.tg_chat_id ? String(space.tg_chat_id) : "";
  const msgId = Array.isArray(msgIds) ? msgIds[0] : msgIds;
  if (!chatId.startsWith("-100") || !msgId) return null;
  return `https://t.me/c/${chatId.slice(4)}/${msgId}`;
}
