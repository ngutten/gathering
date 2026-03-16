// ttl.js — Live countdown ticker for ephemeral messages/topics

let tickerInterval = null;

function formatRemaining(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function tick() {
  const now = Date.now();
  const els = document.querySelectorAll('[data-expires-at]');
  for (const el of els) {
    const expiresAt = new Date(el.getAttribute('data-expires-at'));
    const remaining = Math.round((expiresAt - now) / 1000);

    // Update the TTL badge text
    const badge = el.querySelector('.ttl');
    if (badge) {
      if (remaining > 0) {
        badge.textContent = `[${formatRemaining(remaining)}]`;
      } else {
        badge.textContent = '[0s]';
      }
    }

    // Add urgent class when < 10s remaining
    if (remaining > 0 && remaining < 10) {
      el.classList.add('ttl-urgent');
    }

    // Expire: animate out and remove
    if (remaining <= 0 && !el.classList.contains('msg-expiring')) {
      el.classList.add('msg-expiring');
      el.addEventListener('animationend', () => el.remove(), { once: true });
      // Fallback removal in case animation doesn't fire
      setTimeout(() => { if (el.parentNode) el.remove(); }, 1000);
    }
  }
}

export function startTtlTicker() {
  if (tickerInterval) return;
  tickerInterval = setInterval(tick, 1000);
}

export function stopTtlTicker() {
  if (tickerInterval) {
    clearInterval(tickerInterval);
    tickerInterval = null;
  }
}
