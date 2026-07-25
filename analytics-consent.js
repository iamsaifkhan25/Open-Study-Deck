/* ==========================================================================
   ANALYTICS CONSENT (Basic Consent Mode)
   Single shared module loaded on every page. Google Analytics (gtag.js) is
   never requested until the visitor explicitly grants consent. Declining
   (or not yet deciding) means gtag.js is simply never loaded — no requests,
   no cookies, no events.

   This module must never throw in a way that breaks the page, even if
   localStorage is unavailable or Analytics is blocked by an extension.
   ========================================================================== */

const CONSENT_KEY = 'openstudydeck_analytics_consent';
const CONSENT_VERSION_KEY = 'openstudydeck_analytics_consent_version';
const CURRENT_CONSENT_VERSION = '1';
const GA_MEASUREMENT_ID = 'G-LTBKKM734X';

let gaLoaded = false;
let bannerEl = null;
let lastFocusedBeforeBanner = null;

function safeLocalStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    return null;
  }
}

function safeLocalStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    // Storage unavailable (private mode, quota, disabled) — consent just won't persist.
  }
}

function getStoredConsent() {
  const version = safeLocalStorageGet(CONSENT_VERSION_KEY);
  if (version !== CURRENT_CONSENT_VERSION) return null;
  const value = safeLocalStorageGet(CONSENT_KEY);
  return value === 'granted' || value === 'denied' ? value : null;
}

function storeConsent(value) {
  safeLocalStorageSet(CONSENT_KEY, value);
  safeLocalStorageSet(CONSENT_VERSION_KEY, CURRENT_CONSENT_VERSION);
}

function removeAnalyticsCookies() {
  try {
    const names = document.cookie
      .split(';')
      .map((c) => c.trim().split('=')[0])
      .filter((name) => name === '_ga' || name.startsWith('_ga_') || name === '_gid' || name === '_gat');

    names.forEach((name) => {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=.${location.hostname}`;
    });
  } catch (err) {
    // Best-effort cleanup only — must never block the rest of the app.
  }
}

// Loads gtag.js exactly once, for ordinary page-view measurement only.
// No advertising features, no Google Signals, no user IDs.
export function loadGoogleAnalytics() {
  if (gaLoaded) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  gaLoaded = true;

  try {
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function gtag() { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA_MEASUREMENT_ID, {
      anonymize_ip: true,
      allow_google_signals: false,
      allow_ad_personalization_signals: false
    });

    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
    script.onerror = () => {
      // Blocked by an extension or network — the app must keep working.
    };
    document.head.appendChild(script);
  } catch (err) {
    // Analytics must never break the app.
  }
}

// Sends a custom event only if consent has been granted. Safe to call at any
// time — it silently does nothing before consent or if gtag is unavailable.
export function trackAnalyticsEvent(eventName, params = {}) {
  try {
    if (getStoredConsent() !== 'granted') return;
    if (typeof window === 'undefined' || typeof window.gtag !== 'function') return;
    window.gtag('event', eventName, params);
  } catch (err) {
    // Never let analytics reporting throw into caller code.
  }
}

export function grantAnalyticsConsent() {
  storeConsent('granted');
  loadGoogleAnalytics();
  hideBanner();
}

export function denyAnalyticsConsent() {
  storeConsent('denied');
  removeAnalyticsCookies();
  hideBanner();
}

function buildBanner() {
  const banner = document.createElement('div');
  banner.className = 'analytics-consent-banner';
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-label', 'Analytics consent');

  const text = document.createElement('p');
  text.className = 'analytics-consent-text';
  text.innerHTML =
    'Open Study Deck uses Google Analytics to understand aggregate feature usage and improve the product. ' +
    'It only loads if you allow it — study content, API keys, and generated decks are never sent as analytics data. ' +
    '<a href="privacy" class="analytics-consent-link">Read the Privacy Policy</a>.';

  const actions = document.createElement('div');
  actions.className = 'analytics-consent-actions';

  const allowBtn = document.createElement('button');
  allowBtn.type = 'button';
  allowBtn.className = 'btn btn-primary analytics-consent-btn';
  allowBtn.textContent = 'Allow Analytics';
  allowBtn.addEventListener('click', grantAnalyticsConsent);

  const declineBtn = document.createElement('button');
  declineBtn.type = 'button';
  declineBtn.className = 'btn btn-secondary analytics-consent-btn';
  declineBtn.textContent = 'Decline';
  declineBtn.addEventListener('click', denyAnalyticsConsent);

  actions.appendChild(declineBtn);
  actions.appendChild(allowBtn);

  banner.appendChild(text);
  banner.appendChild(actions);

  return banner;
}

function hideBanner() {
  if (bannerEl) {
    bannerEl.remove();
    bannerEl = null;
    if (lastFocusedBeforeBanner && typeof lastFocusedBeforeBanner.focus === 'function') {
      lastFocusedBeforeBanner.focus();
    }
    lastFocusedBeforeBanner = null;
  }
}

function showBanner() {
  if (bannerEl || !document.body) return;
  lastFocusedBeforeBanner = document.activeElement;
  bannerEl = buildBanner();
  document.body.appendChild(bannerEl);
  const firstButton = bannerEl.querySelector('button');
  if (firstButton) firstButton.focus();
}

// Reopens the consent controls regardless of any prior decision, so users
// can change their mind at any time via an "Analytics Preferences" link.
export function reopenAnalyticsPreferences() {
  showBanner();
}

export function initializeAnalyticsConsent() {
  const consent = getStoredConsent();

  if (consent === 'granted') {
    loadGoogleAnalytics();
  } else if (consent === 'denied') {
    // Do nothing — gtag.js stays unloaded.
  } else {
    const show = () => showBanner();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', show);
    } else {
      show();
    }
  }

  // Any element with [data-analytics-preferences-trigger] reopens the banner.
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-analytics-preferences-trigger]');
    if (trigger) {
      e.preventDefault();
      reopenAnalyticsPreferences();
    }
  });
}

initializeAnalyticsConsent();
