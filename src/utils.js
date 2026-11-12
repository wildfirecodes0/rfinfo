// Shared helpers: INR formatting, HTML escaping, time formatting.
const nf2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** paise → "₹1,250" or "₹12.50" */
function inr(paise) {
  const p = Math.round(Number(paise) || 0);
  const sign = p < 0 ? '-' : '';
  const abs = Math.abs(p);
  return sign + '₹' + (abs % 100 === 0 ? nf0.format(abs / 100) : nf2.format(abs / 100));
}

/** "50", "₹50.5", "50 rs" → paise (integer) or null */
function parseRupees(text) {
  const m = String(text || '')
    .replace(/,/g, '')
    .trim()
    .match(/^(?:₹|rs\.?|inr)?\s*(\d{1,9}(?:\.\d{1,2})?)\s*(?:₹|rs\.?|inr|rupees?)?$/i);
  if (!m) return null;
  return Math.round(Number(m[1]) * 100);
}

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function duration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec % 60}s`;
  return `${sec}s`;
}

function dateIST(ts, withTime = true) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

const UPI_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.]{1,63}$/;
const isUpi = (s) => UPI_RE.test(String(s || '').trim());

const displayName = (u) => (u && (u.first_name || (u.username ? '@' + u.username : String(u.id)))) || 'User';

const maskUpi = (upi) => {
  if (!upi) return '';
  const [a, b] = upi.split('@');
  return (a.length > 3 ? a.slice(0, 2) + '•••' + a.slice(-1) : a[0] + '••') + '@' + b;
};

module.exports = { inr, parseRupees, esc, duration, dateIST, isUpi, displayName, maskUpi };
