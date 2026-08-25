/* ==========================================================================
   OPEN STUDY DECK - APPLICATION CONTROLLER (ES MODULE)
   ========================================================================== */

import { GoogleGenAI } from 'https://cdn.jsdelivr.net/npm/@google/genai/+esm';
import {
  STUDY_MODES,
  MAX_TEXT_INPUT_LENGTH,
  MAX_SUBJECT_CONTEXT_LENGTH,
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_GUEST_IMAGE_BYTES,
  buildModeConfig,
  getModeLabel,
  getOutputTokenBudget,
  classifyGeneratedResponse,
  isRetryableForLength,
  RESPONSE_ISSUE
} from './shared/study-config.js';
import { validateApiKeyFormat } from './shared/api-key-validation.js';
import { mapByokErrorToFailure } from './shared/byok-error-mapping.js';
import {
  initializeAnalyticsConsent,
  trackAnalyticsEvent
} from './analytics-consent.js';
import { initRazorpayDonationFlow } from './shared/razorpay-donations.js';

// --- Storage Keys ---
// Same key name is reused across localStorage/sessionStorage (separate storage areas,
// no collision) so any pre-existing localStorage key from before this change still loads.
const API_KEY_STORAGE_KEY = 'openstudydeck_api_key';
const ACCESS_MODE_STORAGE_KEY = 'openstudydeck_access_mode';

// --- Application State ---
const State = {
  apiKey: '',
  rememberKey: false, // whether the key is persisted in localStorage vs sessionStorage
  activeTab: 'image', // 'image' | 'text'
  uploadedImageBase64: null,
  uploadedImageMimeType: null,
  selectedMode: 'summary', // 'summary' | 'eli5' | 'notes' | 'flashcards'
  selectedTheme: 'aura-mesh', // 'aura-mesh' | 'cyber-midnight' | 'sunset-glow' | 'minimal-grid'
  selectedModel: 'gemini-2.5-flash',
  focusSubjectContext: '',
  isGenerating: false,
  history: [],
  activeDeckId: null,

  // Guest / BYOK access mode
  accessMode: 'guest', // 'guest' | 'byok'
  guestConfig: { guestModeEnabled: false, turnstileSiteKey: null, guestDailyLimit: 5 },
  guestConfigLoaded: false, // true once we have a definitive answer, either way
  // true only when /api/public-config itself could not be reached/parsed
  // (network error, 5xx, malformed body) — distinct from the owner
  // explicitly setting guestModeEnabled:false in a successful response.
  guestConfigUnavailable: false,
  guestUsageRemaining: null,
  turnstileWidgetId: null,
  turnstileToken: null
};

// --- DOM Cache ---
const DOM = {
  // Settings & API inputs
  apiKeyInput: document.getElementById('api-key-input'),
  apiStatus: document.getElementById('api-status'),
  historyList: document.getElementById('history-list'),
  clearHistoryBtn: document.getElementById('clear-history-btn'),
  
  // Workstation Inputs
  tabImage: document.getElementById('tab-image'),
  tabText: document.getElementById('tab-text'),
  imageWorkplace: document.getElementById('image-workplace'),
  textWorkplace: document.getElementById('text-workplace'),
  dropZone: document.getElementById('drop-zone'),
  fileInput: document.getElementById('file-input'),
  dropZonePreview: document.getElementById('drop-zone-preview'),
  previewImage: document.getElementById('preview-image'),
  previewFilename: document.getElementById('preview-filename'),
  btnRemoveFile: document.getElementById('btn-remove-file'),
  textInputField: document.getElementById('text-input-field'),
  charCounter: document.getElementById('char-counter'),
  btnClearText: document.getElementById('btn-clear-text'),
  
  // Advanced Settings
  modelSelector: document.getElementById('model-selector'),
  modelSelectorGuestNote: document.getElementById('model-selector-guest-note'),
  systemContextInput: document.getElementById('system-context-input'),

  // Access Mode (Guest / BYOK)
  accessModeGuestRadio: document.getElementById('access-mode-guest'),
  accessModeByokRadio: document.getElementById('access-mode-byok'),
  accessModeBarDesc: document.getElementById('access-mode-bar-desc'),
  guestPanel: document.getElementById('guest-panel'),
  guestQuotaText: document.getElementById('guest-quota-text'),
  turnstileContainer: document.getElementById('turnstile-container'),
  guestStatusMessage: document.getElementById('guest-status-message'),
  guestConfigRetryBtn: document.getElementById('guest-config-retry-btn'),

  // Action triggers
  generateBtn: document.getElementById('generate-btn'),
  
  // Viewer Canvas
  deckTitleDisplay: document.getElementById('deck-title-display'),
  themeMenuTrigger: document.getElementById('theme-menu-trigger'),
  themeMenu: document.getElementById('theme-menu'),
  exportPngBtn: document.getElementById('export-png-btn'),
  canvasViewport: document.getElementById('canvas-viewport'),
  cardCanvas: document.getElementById('card-canvas'),
  studyCard: document.getElementById('study-card'),
  cardEmptyState: document.getElementById('card-empty-state'),
  cardLoadingState: document.getElementById('card-loading-state'),
  cardContentWrapper: document.getElementById('card-content-wrapper'),
  toastContainer: document.getElementById('toast-container'),
  expandFullscreenBtn: document.getElementById('expand-fullscreen-btn'),
  cardExpandOverlay: document.getElementById('card-expand-overlay'),
  btnCardExpandClick: document.getElementById('btn-card-expand-click')
};

// --- Setup & Initialisation ---
document.addEventListener('DOMContentLoaded', () => {
  loadSavedSettings();
  initThemeToggle();
  initEventListeners();
  checkApiStatus();
  renderHistory();
  initScrollSpy();
  initSmoothScroll();
  initScrollAnimations();
  initModalHandlers();
  initRazorpayDonationFlow({ notify: showToast });
  initAccessMode();

  // Ensure we start with the empty state on page refresh
  setEmptyState();
});

// --- Scroll Spy Logic ---
function initScrollSpy() {
  const sections = document.querySelectorAll('.scroll-page');
  const navItems = document.querySelectorAll('.nav-dock-item');
  
  const observerOptions = {
    root: null,
    rootMargin: '-30% 0px -30% 0px', // Triggers when section occupies middle viewport
    threshold: 0
  };
  
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const id = entry.target.getAttribute('id');
        navItems.forEach(item => {
          if (item.getAttribute('href') === `#${id}`) {
            item.classList.add('active');
          } else {
            item.classList.remove('active');
          }
        });
      }
    });
  }, observerOptions);
  
  sections.forEach(sec => observer.observe(sec));
}

// --- Smooth Anchor Navigation ---
function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      e.preventDefault();
      const targetId = this.getAttribute('href');
      const targetElement = document.querySelector(targetId);
      
      if (targetElement) {
        targetElement.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });
}

// --- Scroll Dynamic Branding Animations ---
let mobileLogoCoords = null;

function calculateMobileLogoCoords() {
  const fixedLogo = document.getElementById('fixed-logo');
  const placeholder = document.getElementById('mobile-logo-placeholder');
  if (!fixedLogo || !placeholder) return;

  const prevTransform = fixedLogo.style.transform;
  const prevTransition = fixedLogo.style.transition;
  
  fixedLogo.style.transition = 'none';
  fixedLogo.style.transform = 'none';
  
  // Force reflow
  fixedLogo.offsetHeight;
  
  const lRect = fixedLogo.getBoundingClientRect();
  const pRect = placeholder.getBoundingClientRect();
  
  const placeholderDocTop = pRect.top + window.scrollY;
  const placeholderDocLeft = pRect.left + window.scrollX;
  
  const endX = lRect.left + (lRect.width / 2);
  const endY = lRect.top + (lRect.height / 2);
  
  fixedLogo.style.transform = prevTransform;
  fixedLogo.style.transition = prevTransition;
  
  mobileLogoCoords = {
    docStartX: placeholderDocLeft + (pRect.width / 2),
    docStartY: placeholderDocTop + (pRect.height / 2),
    endX: endX,
    endY: endY
  };
}

function initScrollAnimations() {
  const heroTitle = document.querySelector('.hero-title');
  const heroLogo = document.querySelector('.hero-content .logo-wrapper');
  const fixedLogo = document.getElementById('fixed-logo');
  const placeholder = document.getElementById('mobile-logo-placeholder');
  
  if (!heroTitle || !fixedLogo) return;
  
  let ticking = false;
  let coordsCalculated = false;
  
  // Perform coordinates calculation
  calculateMobileLogoCoords();
  
  window.addEventListener('resize', () => {
    calculateMobileLogoCoords();
    updateAnimation();
  });
  
  window.addEventListener('load', () => {
    calculateMobileLogoCoords();
    updateAnimation();
  });
  
  function updateAnimation() {
    const scrollY = window.scrollY;
    const isMobile = window.innerWidth < 768;
    
    // Animation range: from 0px to 200px scroll
    const maxScroll = 200;
    const progress = Math.min(scrollY / maxScroll, 1);
    
    // Fade out and translate/scale the hero title
    heroTitle.style.opacity = (1 - progress).toString();
    heroTitle.style.transform = `scale(${1 - 0.15 * progress}) translateY(${-30 * progress}px)`;
    
    // Fade out the center hero logo if it exists
    if (heroLogo) {
      heroLogo.style.opacity = (1 - progress).toString();
      heroLogo.style.transform = `scale(${1 - 0.2 * progress}) translateY(${-20 * progress}px)`;
    }
    
    // Manage scrolled class on fixed-logo for homepage transition
    if (scrollY > 50) {
      fixedLogo.classList.add('scrolled');
    } else {
      fixedLogo.classList.remove('scrolled');
    }
    
    // Mobile-specific logo sliding transition
    if (isMobile && placeholder) {
      if (!coordsCalculated || !mobileLogoCoords || scrollY === 0) {
        calculateMobileLogoCoords();
        coordsCalculated = true;
      }
      
      if (mobileLogoCoords) {
        const startX = mobileLogoCoords.docStartX - window.scrollX;
        const startY = mobileLogoCoords.docStartY - window.scrollY;
        
        const diffX = startX - mobileLogoCoords.endX;
        const diffY = startY - mobileLogoCoords.endY;
        
        const translateX = diffX * (1 - progress);
        const translateY = diffY * (1 - progress);
        const scale = 1 + 0.35 * (1 - progress); // Scales from 1.35 down to 1.0
        
        fixedLogo.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
      }
    } else {
      // Clear inline transform for desktop viewports
      fixedLogo.style.transform = '';
    }
  }
  
  window.addEventListener('scroll', () => {
    if (!ticking) {
      window.requestAnimationFrame(() => {
        updateAnimation();
        ticking = false;
      });
      ticking = true;
    }
  }, { passive: true });
  
  // Initial run
  updateAnimation();
}

// --- Local Storage Management ---
function loadSavedSettings() {
  // A key already in localStorage (legacy behaviour, or a prior "remember" opt-in)
  // takes priority and implies "Remember this key on this device" is enabled.
  const persistedKey = localStorage.getItem(API_KEY_STORAGE_KEY);
  if (persistedKey) {
    State.apiKey = persistedKey;
    State.rememberKey = true;
  } else {
    State.apiKey = sessionStorage.getItem(API_KEY_STORAGE_KEY) || '';
    State.rememberKey = false;
  }
  syncApiKeyUI();

  // Load History
  try {
    const rawHistory = localStorage.getItem('openstudydeck_history');
    State.history = rawHistory ? JSON.parse(rawHistory) : [];
  } catch (err) {
    console.error('Failed to parse history from localStorage', err);
    State.history = [];
  }
  
  // Load Preferences
  State.selectedTheme = localStorage.getItem('openstudydeck_pref_theme') || 'aura-mesh';
  applyTheme(State.selectedTheme);
  
  State.selectedModel = localStorage.getItem('openstudydeck_pref_model') || 'gemini-2.5-flash';
  DOM.modelSelector.value = State.selectedModel;
  
  State.focusSubjectContext = localStorage.getItem('openstudydeck_pref_context') || '';
  DOM.systemContextInput.value = State.focusSubjectContext;
}

function saveHistory() {
  localStorage.setItem('openstudydeck_history', JSON.stringify(State.history));
  renderHistory();
}

// --- Status & Theme Updates ---
function checkApiStatus() {
  const badges = [DOM.apiStatus, document.getElementById('api-status-modal')];

  badges.forEach(badge => {
    if (!badge) return;
    const dot = badge.querySelector('.status-dot');
    const text = badge.querySelector('.status-text');

    if (State.apiKey) {
      // Format validation only — this does not confirm the key is active with Google.
      dot.className = 'status-dot dot-green';
      text.textContent = 'Key Configured';
    } else {
      dot.className = 'status-dot dot-red';
      text.textContent = 'Key Required';
    }
  });
}

// Keeps both API-key inputs, both "Remember" checkboxes, storage-status notes,
// the remember-warning visibility, and the status badges all in sync with State.
function syncApiKeyUI() {
  const inputs = [DOM.apiKeyInput, document.getElementById('api-key-input-modal')];
  const checkboxes = [document.getElementById('remember-key-checkbox'), document.getElementById('remember-key-checkbox-modal')];
  const warnings = [document.getElementById('api-key-remember-warning'), document.getElementById('api-key-remember-warning-modal')];
  const notes = [document.getElementById('api-key-storage-note'), document.getElementById('api-key-storage-note-modal')];

  inputs.forEach(input => { if (input) input.value = State.apiKey; });
  checkboxes.forEach(cb => { if (cb) cb.checked = State.rememberKey; });
  warnings.forEach(w => { if (w) w.style.display = State.rememberKey ? 'block' : 'none'; });

  let noteText = '';
  if (State.apiKey) {
    noteText = State.rememberKey
      ? 'Key remembered on this device. Avoid using this option on shared computers.'
      : 'Key saved for this browser session.';
  }
  notes.forEach(n => { if (n) n.textContent = noteText; });

  checkApiStatus();
}

function applyTheme(themeName) {
  // Update state & localStorage
  State.selectedTheme = themeName;
  localStorage.setItem('openstudydeck_pref_theme', themeName);
  
  // Reset themes classes on canvas
  DOM.cardCanvas.className = `card-canvas theme-${themeName}`;
  
  // Also update theme on cloned canvas if full-screen modal is open
  const cloneCanvas = document.getElementById('fullscreen-card-canvas');
  if (cloneCanvas) {
    cloneCanvas.className = `card-canvas theme-${themeName}`;
  }
  
  // Mark current active theme in menu dropdown
  document.querySelectorAll('.theme-option').forEach(btn => {
    if (btn.dataset.theme === themeName) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

// --- Toast System ---
function showToast(message, type = 'info', duration = 4000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  let iconSvg = '';
  if (type === 'success') {
    iconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
  } else if (type === 'error') {
    iconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;
  } else if (type === 'warning') {
    iconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
  } else {
    iconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
  }
  
  toast.innerHTML = `
    <div class="toast-icon">${iconSvg}</div>
    <div class="toast-content">${escapeHtml(message)}</div>
  `;
  
  DOM.toastContainer.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'toastSlideIn 0.3s cubic-bezier(0.4, 0, 0.2, 1) reverse forwards';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// --- Event Listeners Registration ---
function initEventListeners() {
  // 1. API Key Handlers (Settings Section & Modal Synchronized)
  document.querySelectorAll('.btn-save-key-class').forEach(btn => {
    btn.addEventListener('click', () => {
      const sourceInputId = btn.dataset.sourceInput;
      const checkboxId = btn.dataset.rememberCheckbox;
      const inputEl = document.getElementById(sourceInputId);
      const checkboxEl = checkboxId ? document.getElementById(checkboxId) : null;
      if (inputEl) saveApiKey(inputEl.value, checkboxEl ? checkboxEl.checked : false);
    });
  });

  document.querySelectorAll('.btn-clear-key-class').forEach(btn => {
    btn.addEventListener('click', clearApiKey);
  });

  document.querySelectorAll('.toggle-key-visibility-class').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetInputId = btn.dataset.targetInput;
      const inputEl = document.getElementById(targetInputId);
      if (inputEl) toggleKeyVisibility(inputEl, btn);
    });
  });

  // Keep both "Remember this key on this device" checkboxes in sync and toggle the warning live
  document.querySelectorAll('.remember-key-checkbox-class').forEach(cb => {
    cb.addEventListener('change', () => {
      document.querySelectorAll('.remember-key-checkbox-class').forEach(other => {
        other.checked = cb.checked;
      });
      document.querySelectorAll('.remember-key-warning').forEach(w => {
        w.style.display = cb.checked ? 'block' : 'none';
      });
    });
  });

  // Handle keyboard submission on both inputs
  [DOM.apiKeyInput, document.getElementById('api-key-input-modal')].forEach(input => {
    if (input) {
      input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          const isModal = input.id === 'api-key-input-modal';
          const checkboxEl = document.getElementById(isModal ? 'remember-key-checkbox-modal' : 'remember-key-checkbox');
          saveApiKey(input.value, checkboxEl ? checkboxEl.checked : false);
        }
      });
    }
  });
  
  // 2. Input Tab Controls
  DOM.tabImage.addEventListener('click', () => switchInputTab('image'));
  DOM.tabText.addEventListener('click', () => switchInputTab('text'));

  // 2b. Study Mode selection
  document.querySelectorAll('input[name="study-mode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.checked) trackAnalyticsEvent('study_mode_selected', { study_mode: radio.value });
    });
  });

  // 3. Drag & Drop Upload
  const selectFileTrigger = DOM.dropZone.querySelector('.select-file-trigger');
  selectFileTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    DOM.fileInput.click();
  });
  DOM.dropZone.addEventListener('click', () => DOM.fileInput.click());
  DOM.fileInput.addEventListener('change', handleFileSelect);
  
  DOM.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    DOM.dropZone.classList.add('drag-over');
  });
  DOM.dropZone.addEventListener('dragleave', () => {
    DOM.dropZone.classList.remove('drag-over');
  });
  DOM.dropZone.addEventListener('drop', handleFileDrop);
  DOM.btnRemoveFile.addEventListener('click', (e) => {
    e.stopPropagation();
    clearUploadedImage();
  });
  
  // 4. Textarea handlers
  DOM.textInputField.addEventListener('input', handleTextInput);
  DOM.btnClearText.addEventListener('click', clearTextArea);
  
  // 5. Advanced Preferences
  DOM.modelSelector.addEventListener('change', (e) => {
    State.selectedModel = e.target.value;
    localStorage.setItem('openstudydeck_pref_model', State.selectedModel);
  });
  DOM.systemContextInput.addEventListener('input', (e) => {
    State.focusSubjectContext = e.target.value;
    localStorage.setItem('openstudydeck_pref_context', State.focusSubjectContext);
  });
  
  // 6. Action Button (Analyze & Generate)
  DOM.generateBtn.addEventListener('click', handleGenerateDeck);
  
  // 7. Theme Controls
  DOM.themeMenuTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    DOM.themeMenu.classList.toggle('show');
    const isExpanded = DOM.themeMenu.classList.contains('show');
    DOM.themeMenuTrigger.setAttribute('aria-expanded', isExpanded);
  });
  
  document.addEventListener('click', () => {
    DOM.themeMenu.classList.remove('show');
    DOM.themeMenuTrigger.setAttribute('aria-expanded', 'false');
  });
  
  DOM.themeMenu.querySelectorAll('.theme-option').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const theme = btn.dataset.theme;
      applyTheme(theme);
      DOM.themeMenu.classList.remove('show');
      DOM.themeMenuTrigger.setAttribute('aria-expanded', 'false');
      showToast(`Applied ${btn.textContent.trim()} theme`, 'success', 2000);
      trackAnalyticsEvent('theme_selected', { theme_name: theme });
    });
  });
  
  // 8. Export PNG
  DOM.exportPngBtn.addEventListener('click', handlePngExport);
  
  // 9. Fullscreen views
  DOM.expandFullscreenBtn.addEventListener('click', openFullscreenView);
  DOM.btnCardExpandClick.addEventListener('click', openFullscreenView);
  
  // 10. Modals keyboard Escape behavior
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const apiModal = document.getElementById('api-modal');
      const supportModal = document.getElementById('support-modal');
      const fullscreenModal = document.getElementById('fullscreen-modal');
      if (apiModal) apiModal.style.display = 'none';
      if (supportModal) supportModal.style.display = 'none';
      if (fullscreenModal) fullscreenModal.style.display = 'none';
    }
  });
  
  // 11. History Drawer Clear All
  DOM.clearHistoryBtn.addEventListener('click', handleClearAllHistory);
}

// --- API Key Handlers ---
function saveApiKey(rawValue, remember) {
  const result = validateApiKeyFormat(rawValue);
  if (!result.valid) {
    showToast(result.reason, 'warning');
    return;
  }

  State.apiKey = result.value;
  State.rememberKey = !!remember;

  if (State.rememberKey) {
    localStorage.setItem(API_KEY_STORAGE_KEY, State.apiKey);
    sessionStorage.removeItem(API_KEY_STORAGE_KEY);
  } else {
    sessionStorage.setItem(API_KEY_STORAGE_KEY, State.apiKey);
    localStorage.removeItem(API_KEY_STORAGE_KEY);
  }

  syncApiKeyUI();
  showToast(
    State.rememberKey
      ? 'Key remembered on this device. Avoid using this option on shared computers.'
      : 'Key saved for this browser session.',
    'success'
  );

  // Close modal if open
  document.getElementById('api-modal').style.display = 'none';
}

function clearApiKey() {
  State.apiKey = '';
  State.rememberKey = false;

  localStorage.removeItem(API_KEY_STORAGE_KEY);
  sessionStorage.removeItem(API_KEY_STORAGE_KEY);

  syncApiKeyUI();
  showToast('API key removed from this browser.', 'info');

  // Close modal if open
  document.getElementById('api-modal').style.display = 'none';
}

function toggleKeyVisibility(inputEl, btnEl) {
  if (inputEl.type === 'password') {
    inputEl.type = 'text';
    btnEl.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
        <circle cx="12" cy="12" r="3"></circle>
      </svg>
    `;
  } else {
    inputEl.type = 'password';
    btnEl.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
        <line x1="1" y1="1" x2="23" y2="23"></line>
      </svg>
    `;
  }
}

// --- Access Mode (Guest vs BYOK) ---
function initAccessMode() {
  const storedMode = localStorage.getItem(ACCESS_MODE_STORAGE_KEY);
  State.accessMode = storedMode === 'byok' ? 'byok' : 'guest'; // guest is the default for new visitors

  if (DOM.accessModeGuestRadio) DOM.accessModeGuestRadio.checked = State.accessMode === 'guest';
  if (DOM.accessModeByokRadio) DOM.accessModeByokRadio.checked = State.accessMode === 'byok';

  [DOM.accessModeGuestRadio, DOM.accessModeByokRadio].forEach((radio) => {
    if (!radio) return;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      State.accessMode = radio.value === 'byok' ? 'byok' : 'guest';
      localStorage.setItem(ACCESS_MODE_STORAGE_KEY, State.accessMode);
      syncAccessModeUI();
    });
  });

  if (DOM.guestConfigRetryBtn) {
    DOM.guestConfigRetryBtn.addEventListener('click', () => {
      fetchPublicConfig();
    });
  }

  syncAccessModeUI();
  fetchPublicConfig();
}

async function fetchPublicConfig() {
  if (DOM.guestQuotaText) DOM.guestQuotaText.textContent = 'Checking guest availability…';
  if (DOM.guestConfigRetryBtn) DOM.guestConfigRetryBtn.style.display = 'none';
  State.guestConfigUnavailable = false;

  try {
    const res = await fetch('/api/public-config');
    if (!res.ok) throw new Error('public-config request failed');
    const data = await res.json();
    if (!data || typeof data !== 'object') throw new Error('malformed public-config response');
    State.guestConfig = {
      guestModeEnabled: !!data.guestModeEnabled,
      turnstileSiteKey: data.turnstileSiteKey || null,
      guestDailyLimit: Number(data.guestDailyLimit) > 0 ? Number(data.guestDailyLimit) : 5
    };
  } catch (err) {
    // The config endpoint itself could not be reached or parsed — this is
    // NOT the same as the owner explicitly disabling guest access, so it
    // must not be reported to the user as "Guest Access has been disabled".
    State.guestConfig = { guestModeEnabled: false, turnstileSiteKey: null, guestDailyLimit: 5 };
    State.guestConfigUnavailable = true;
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      console.info('[Open Study Deck] /api/public-config could not be reached. Plain `npm run dev` mocks this route already; for full Cloudflare Pages Functions parity (real KV bindings, etc.) use `npm run dev:cf` (wrangler pages dev). See docs/CLOUDFLARE_GUEST_AI_SETUP.md.');
    }
  }

  State.guestConfigLoaded = true;
  syncAccessModeUI();
}

function syncAccessModeUI() {
  const isGuest = State.accessMode === 'guest';

  // Explicitly disabled: the config endpoint responded successfully and the
  // owner has guestModeEnabled:false (or omitted the Turnstile site key
  // while still enabling guest mode, which is also an owner-side
  // misconfiguration rather than a transient fetch failure).
  const isExplicitlyDisabled = State.guestConfigLoaded && !State.guestConfigUnavailable &&
    !State.guestConfig.guestModeEnabled;

  // Temporarily unavailable: the config request itself failed (network,
  // 5xx, malformed body), or it succeeded with guest mode "on" but missing
  // the Turnstile site key it needs to actually run.
  const isConfigUnavailable = State.guestConfigLoaded &&
    (State.guestConfigUnavailable || (State.guestConfig.guestModeEnabled && !State.guestConfig.turnstileSiteKey));

  const guestKnownUnavailable = isExplicitlyDisabled || isConfigUnavailable;

  // Once we know guest access is unavailable, disable the option outright —
  // otherwise a user could select it and only discover it's a dead end after
  // hitting "Analyze & Generate".
  if (DOM.accessModeGuestRadio) {
    DOM.accessModeGuestRadio.disabled = guestKnownUnavailable;
    DOM.accessModeGuestRadio.setAttribute('aria-disabled', String(guestKnownUnavailable));
    const guestPill = DOM.accessModeGuestRadio.closest('.access-mode-pill');
    if (guestPill) guestPill.classList.toggle('is-disabled', guestKnownUnavailable);
  }

  if (guestKnownUnavailable && isGuest) {
    State.accessMode = 'byok';
    localStorage.setItem(ACCESS_MODE_STORAGE_KEY, State.accessMode);
    if (DOM.accessModeByokRadio) DOM.accessModeByokRadio.checked = true;
    if (DOM.accessModeGuestRadio) DOM.accessModeGuestRadio.checked = false;
    showToast(
      isExplicitlyDisabled
        ? 'Guest access is currently disabled on this deployment — switched to "Use My Own Key".'
        : 'Guest access is temporarily unavailable — switched to "Use My Own Key".',
      'info'
    );
    return syncAccessModeUI();
  }

  if (DOM.accessModeBarDesc) {
    DOM.accessModeBarDesc.textContent = isGuest
      ? 'Try Open Study Deck without configuring an API key. Guest generations are limited to protect the free service.'
      : 'Use your personal Gemini API quota for additional generations and direct browser-to-Google requests.';
  }

  // Lives next to the description (not inside .guest-panel) so it stays
  // reachable even after guestKnownUnavailable forces a switch to BYOK and
  // hides the guest panel — otherwise a disabled Guest radio would leave the
  // user with no way to retry short of a full page reload. Never shown for
  // an explicit disable, since retrying can't fix an owner's deliberate choice.
  if (DOM.guestConfigRetryBtn) {
    DOM.guestConfigRetryBtn.style.display = isConfigUnavailable ? 'inline-block' : 'none';
  }

  if (DOM.guestPanel) DOM.guestPanel.style.display = isGuest ? 'flex' : 'none';

  // Guest mode uses a server-controlled model — never let the browser pick one.
  if (DOM.modelSelector) DOM.modelSelector.disabled = isGuest;
  if (DOM.modelSelectorGuestNote) DOM.modelSelectorGuestNote.style.display = isGuest ? 'block' : 'none';

  if (!isGuest) {
    if (DOM.guestStatusMessage) {
      DOM.guestStatusMessage.textContent = '';
      DOM.guestStatusMessage.classList.remove('is-error');
    }
    return;
  }

  if (!State.guestConfigLoaded) {
    if (DOM.guestQuotaText) DOM.guestQuotaText.textContent = 'Checking guest availability…';
    return;
  }

  if (isExplicitlyDisabled) {
    if (DOM.guestQuotaText) {
      DOM.guestQuotaText.textContent = 'Guest Access is currently disabled. You can continue using your own Gemini key.';
    }
    if (DOM.turnstileContainer) DOM.turnstileContainer.innerHTML = '';
    return;
  }

  if (isConfigUnavailable) {
    if (DOM.guestQuotaText) {
      DOM.guestQuotaText.textContent = 'Guest Access is temporarily unavailable because its configuration could not be loaded. You can use BYOK or try again later.';
    }
    if (DOM.turnstileContainer) DOM.turnstileContainer.innerHTML = '';
    return;
  }

  const remaining = State.guestUsageRemaining;
  if (DOM.guestQuotaText) {
    DOM.guestQuotaText.textContent = remaining === null
      ? `You have up to ${State.guestConfig.guestDailyLimit} free guest generations today.`
      : `${remaining} of ${State.guestConfig.guestDailyLimit} guest generations remaining today.`;
  }

  renderTurnstileWidget();
}

// --- Turnstile (guest verification) ---
let turnstileScriptPromise = null;

function loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve();
  if (turnstileScriptPromise) return turnstileScriptPromise;

  turnstileScriptPromise = new Promise((resolvePromise, rejectPromise) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.onload = () => resolvePromise();
    script.onerror = () => rejectPromise(new Error('Failed to load Turnstile'));
    document.body.appendChild(script);
  });

  return turnstileScriptPromise;
}

async function renderTurnstileWidget() {
  if (!DOM.turnstileContainer || State.turnstileWidgetId !== null) return;
  if (!State.guestConfig.turnstileSiteKey) return;

  try {
    await loadTurnstileScript();
    if (!window.turnstile || State.turnstileWidgetId !== null) return;

    State.turnstileWidgetId = window.turnstile.render(DOM.turnstileContainer, {
      sitekey: State.guestConfig.turnstileSiteKey,
      callback: (token) => {
        State.turnstileToken = token;
        if (DOM.guestStatusMessage) {
          DOM.guestStatusMessage.textContent = '';
          DOM.guestStatusMessage.classList.remove('is-error');
        }
      },
      'expired-callback': () => {
        State.turnstileToken = null;
      },
      'error-callback': () => {
        State.turnstileToken = null;
        if (DOM.guestStatusMessage) {
          DOM.guestStatusMessage.textContent = 'Verification widget failed to load. Please refresh or use BYOK.';
          DOM.guestStatusMessage.classList.add('is-error');
        }
      }
    });
  } catch (err) {
    if (DOM.guestStatusMessage) {
      DOM.guestStatusMessage.textContent = 'Verification widget failed to load. Please refresh or use BYOK.';
      DOM.guestStatusMessage.classList.add('is-error');
    }
  }
}

function resetTurnstileWidget() {
  State.turnstileToken = null;
  if (window.turnstile && State.turnstileWidgetId !== null) {
    try {
      window.turnstile.reset(State.turnstileWidgetId);
    } catch (err) {
      // Non-fatal — a fresh page load will re-render the widget if this fails.
    }
  }
}

// --- Guest error handling ---
function mapGuestErrorToFailureCategory(code) {
  const map = {
    TURNSTILE_REQUIRED: 'invalid_input',
    TURNSTILE_FAILED: 'invalid_input',
    GUEST_DAILY_LIMIT_REACHED: 'quota',
    INVALID_INPUT: 'invalid_input',
    INPUT_TOO_LARGE: 'invalid_input',
    UNSUPPORTED_FILE_TYPE: 'invalid_input',
    MODEL_UNAVAILABLE: 'model_unavailable',
    GEMINI_RATE_LIMIT: 'rate_limit',
    GEMINI_QUOTA_EXCEEDED: 'quota',
    GEMINI_SAFETY_BLOCK: 'safety_block',
    GEMINI_SERVICE_UNAVAILABLE: 'service_unavailable',
    SERVER_CONFIGURATION_ERROR: 'service_unavailable',
    GUEST_MODE_DISABLED: 'service_unavailable',
    RESPONSE_TOO_LONG: 'response_too_long',
    RESPONSE_INCOMPLETE: 'invalid_response',
    RESPONSE_INVALID_FORMAT: 'invalid_response',
    RESPONSE_EMPTY: 'invalid_response'
  };
  return map[code] || 'unknown';
}

function guestErrorToUserMessage(code, extra = {}) {
  switch (code) {
    case 'GUEST_MODE_DISABLED':
      return 'Guest access is not available on this deployment right now. You can switch to "Use My Own Key" instead.';
    case 'TURNSTILE_REQUIRED':
      return 'Please complete the verification challenge, then try again.';
    case 'TURNSTILE_FAILED':
      return 'Verification failed. Please retry the challenge.';
    case 'GUEST_DAILY_LIMIT_REACHED': {
      const resets = extra.resetsAt ? new Date(extra.resetsAt).toLocaleString() : 'later today';
      return `Guest access has reached today's allowance. You can try again after ${resets}, or continue using your own Gemini key.`;
    }
    case 'INVALID_INPUT':
      return 'Your request could not be processed. Please check your input and try again.';
    case 'INPUT_TOO_LARGE':
      return 'Your image is too large for guest access. Compress it or use BYOK mode.';
    case 'UNSUPPORTED_FILE_TYPE':
      return 'That image type is not supported for guest access.';
    case 'MODEL_UNAVAILABLE':
      return 'The guest AI model is temporarily unavailable. Please try again shortly.';
    case 'GEMINI_RATE_LIMIT':
      return 'Too many requests right now. Please wait a moment and try again.';
    case 'GEMINI_QUOTA_EXCEEDED':
      return 'The guest service has reached its usage quota. Please try again later or use BYOK.';
    case 'GEMINI_SAFETY_BLOCK':
      return 'The AI declined to process this content.';
    case 'GEMINI_SERVICE_UNAVAILABLE':
      return "Google's AI service is temporarily unavailable. Your material was not saved by Open Study Deck.";
    case 'SERVER_CONFIGURATION_ERROR':
      return 'Guest access is temporarily misconfigured. Please use your own Gemini key.';
    case 'RESPONSE_TOO_LONG':
      return 'The generated study deck was too large to complete reliably. Try a shorter source, choose Summary mode, or split the material into smaller sections.';
    case 'RESPONSE_INCOMPLETE':
    case 'RESPONSE_INVALID_FORMAT':
      return 'The AI returned an incomplete study deck. Please try again. If the source is very long, use a shorter section.';
    case 'RESPONSE_EMPTY':
      return "Google's AI service did not return usable study content. Please retry with clearer source material.";
    default:
      return 'Something went wrong. Please try again.';
  }
}

// --- Input Tab Navigation ---
function switchInputTab(tabType) {
  State.activeTab = tabType;
  trackAnalyticsEvent('input_mode_selected', { input_type: tabType });

  if (tabType === 'image') {
    DOM.tabImage.classList.add('active');
    DOM.tabText.classList.remove('active');
    DOM.imageWorkplace.classList.add('active');
    DOM.textWorkplace.classList.remove('active');
  } else {
    DOM.tabText.classList.add('active');
    DOM.tabImage.classList.remove('active');
    DOM.textWorkplace.classList.add('active');
    DOM.imageWorkplace.classList.remove('active');
  }
}

// --- File Reading / Uploads ---
function handleFileSelect(e) {
  const files = e.target.files;
  if (files && files.length > 0) {
    processUploadedFile(files[0]);
  }
}

function handleFileDrop(e) {
  e.preventDefault();
  DOM.dropZone.classList.remove('drag-over');
  
  const files = e.dataTransfer.files;
  if (files && files.length > 0) {
    processUploadedFile(files[0]);
  }
}

function processUploadedFile(file) {
  if (!file.type.match('image/jpeg') && !file.type.match('image/png')) {
    showToast('Unsupported file type. Please upload a JPEG or PNG image.', 'error');
    return;
  }
  
  if (file.size > 10 * 1024 * 1024) {
    showToast('File is too large. Max size is 10MB.', 'error');
    return;
  }
  
  const reader = new FileReader();
  
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    
    State.uploadedImageMimeType = file.type;
    State.uploadedImageFileName = file.name;
    State.uploadedImageBase64 = dataUrl.split(',')[1];
    
    DOM.previewImage.src = dataUrl;
    DOM.previewFilename.textContent = file.name;
    DOM.dropZonePreview.style.display = 'flex';
    
    showToast('Image successfully processed.', 'success', 2000);
  };
  
  reader.onerror = () => {
    showToast('Failed to read file. Please try again.', 'error');
    clearUploadedImage();
  };
  
  reader.readAsDataURL(file);
}

function clearUploadedImage() {
  State.uploadedImageBase64 = null;
  State.uploadedImageMimeType = null;
  State.uploadedImageFileName = null;
  DOM.fileInput.value = '';
  DOM.dropZonePreview.style.display = 'none';
  DOM.previewImage.src = '';
  DOM.previewFilename.textContent = '';
  setEmptyState();
}

// --- Textarea Handlers ---
function handleTextInput(e) {
  const text = e.target.value;
  DOM.charCounter.textContent = `${text.length} characters`;
  
  if (text.length > 0) {
    DOM.btnClearText.style.display = 'inline';
  } else {
    DOM.btnClearText.style.display = 'none';
    setEmptyState();
  }
}

function clearTextArea() {
  DOM.textInputField.value = '';
  DOM.charCounter.textContent = '0 characters';
  DOM.btnClearText.style.display = 'none';
  setEmptyState();
}

// --- Gemini Generation Process ---

// Reads and validates the active input tab. Returns null (after showing a
// toast) if nothing usable was provided; shared by both the guest and BYOK
// generation paths so validation never drifts between them.
function gatherGenerationInput() {
  if (State.activeTab === 'image') {
    if (!State.uploadedImageBase64) {
      showToast('Please upload or drag an image containing textbooks/notes.', 'warning');
      return null;
    }
    return {
      inputType: 'image',
      sourceContext: `${State.uploadedImageFileName}`,
      imageBase64: State.uploadedImageBase64,
      imageMimeType: State.uploadedImageMimeType
    };
  }

  const rawText = DOM.textInputField.value.trim();
  if (!rawText) {
    showToast('Please paste notes or textbook excerpts in the text workstation.', 'warning');
    DOM.textInputField.focus();
    return null;
  }
  return {
    inputType: 'text',
    sourceContext: rawText.length > 30 ? rawText.substring(0, 27) + '...' : rawText,
    text: rawText
  };
}

function handleGenerateDeck() {
  const checkedMode = document.querySelector('input[name="study-mode"]:checked');
  State.selectedMode = checkedMode ? checkedMode.value : 'summary';

  if (State.accessMode === 'guest') {
    handleGuestGeneration();
  } else {
    handleByokGeneration();
  }
}

// --- BYOK generation: browser -> Google Gemini directly ---
async function handleByokGeneration() {
  if (!State.apiKey) {
    showToast('API Key is missing. Configure it in settings or the top right corner.', 'error');
    // Open API modal directly for them to configure
    document.getElementById('api-modal').style.display = 'flex';
    setTimeout(() => {
      const modalInput = document.getElementById('api-key-input-modal');
      if (modalInput) modalInput.focus();
    }, 300);
    return;
  }

  const input = gatherGenerationInput();
  if (!input) return;

  const payloadObject = input.inputType === 'image'
    ? { inlineData: { data: input.imageBase64, mimeType: input.imageMimeType } }
    : input.text;

  const sourceLength = input.inputType === 'text' ? input.text.length : 0;

  trackAnalyticsEvent('generation_started', { access_mode: 'byok', study_mode: State.selectedMode, input_type: input.inputType });
  setGenerationLoadingState(true);

  try {
    const ai = new GoogleGenAI({ apiKey: State.apiKey });
    const result = await generateByokDeck({
      ai,
      model: State.selectedModel,
      payloadObject,
      mode: State.selectedMode,
      subjectContext: State.focusSubjectContext,
      sourceLength
    });
    const parsedData = result.data;

    const deckRecord = {
      id: 'deck_' + Date.now(),
      title: parsedData.title || 'Untitled Study Deck',
      subtitle: parsedData.subtitle || `Source: ${input.sourceContext}`,
      mode: State.selectedMode,
      data: parsedData,
      sourceType: input.inputType,
      accessMode: 'byok',
      timestamp: Date.now()
    };

    State.history.unshift(deckRecord);
    saveHistory();
    loadDeck(deckRecord.id);

    showToast('Study Card generated successfully!', 'success');
    trackAnalyticsEvent('generation_succeeded', { access_mode: 'byok', study_mode: State.selectedMode, input_type: input.inputType });
  } catch (err) {
    let errorMsg;
    let failureCategory;

    if (err.responseIssue) {
      const mapped = mapResponseIssueToByokMessage(err.responseIssue, err.completion);
      errorMsg = mapped.message;
      failureCategory = mapped.failureCategory;
    } else {
      const mapped = mapByokErrorToFailure(err);
      errorMsg = mapped.message;
      failureCategory = mapped.failureCategory;
    }

    // Safe diagnostic only — HTTP status and our own category, never the
    // key, the raw Google error body, or request/generated content.
    console.error(`BYOK Gemini API error — category=${failureCategory} status=${err && typeof err.status === 'number' ? err.status : 'n/a'}`);

    showToast(errorMsg, 'error', 6000);
    trackAnalyticsEvent('generation_failed', { access_mode: 'byok', failure_category: failureCategory });

    if (!State.activeDeckId) {
      setEmptyState();
    } else {
      loadDeck(State.activeDeckId);
    }
  } finally {
    setGenerationLoadingState(false);
  }
}

// Maps an internal response-classification issue to the same quality of
// actionable message the guest endpoint returns, without routing the
// personal BYOK key through the guest endpoint or its error-code system.
function mapResponseIssueToByokMessage(issue, completion) {
  const tooLong = {
    message: 'The generated study deck was too large to complete reliably. Try a shorter source, choose Summary mode, or split the material into smaller sections.',
    failureCategory: 'response_too_long'
  };
  const invalidResponse = {
    message: 'The AI returned an incomplete study deck. Please try again. If the source is very long, use a shorter section.',
    failureCategory: 'invalid_response'
  };

  switch (issue) {
    case RESPONSE_ISSUE.SAFETY_BLOCK:
      return { message: 'The AI declined to process this content.', failureCategory: 'safety_block' };
    case RESPONSE_ISSUE.EMPTY:
      return {
        message: "Google's AI service did not return usable study content. Please retry with clearer source material.",
        failureCategory: 'invalid_response'
      };
    case RESPONSE_ISSUE.MAX_TOKENS_NO_TEXT:
      return tooLong;
    case RESPONSE_ISSUE.TRUNCATED_JSON:
      return completion === 'max_tokens' ? tooLong : invalidResponse;
    case RESPONSE_ISSUE.INVALID_STRUCTURE:
    case RESPONSE_ISSUE.MALFORMED_JSON:
      return invalidResponse;
    default:
      return { message: 'Something went wrong. Please try again.', failureCategory: 'unknown' };
  }
}

// --- Guest generation: browser -> Open Study Deck Cloudflare Function -> Google Gemini ---
async function handleGuestGeneration() {
  if (!State.guestConfigLoaded) {
    showToast('Checking guest availability — please try again in a moment.', 'info');
    return;
  }
  if (!State.guestConfig.guestModeEnabled || !State.guestConfig.turnstileSiteKey) {
    // Guest generation must fail closed here too — syncAccessModeUI() should
    // already have disabled the radio and switched to BYOK, but this is the
    // authoritative guard in case that hasn't run yet.
    const message = State.guestConfigUnavailable
      ? 'Guest Access is temporarily unavailable because its configuration could not be loaded. You can use BYOK or try again later.'
      : 'Guest Access is currently disabled. You can continue using your own Gemini key.';
    showToast(message, 'error', 6000);
    return;
  }

  const input = gatherGenerationInput();
  if (!input) return;

  if (input.inputType === 'text' && input.text.length > MAX_TEXT_INPUT_LENGTH) {
    showToast(`Guest text input is limited to ${MAX_TEXT_INPUT_LENGTH.toLocaleString()} characters. Please shorten it or use BYOK.`, 'warning');
    return;
  }

  if (input.inputType === 'image') {
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(input.imageMimeType)) {
      showToast('That image type is not supported for guest access. Use JPEG, PNG, or WebP.', 'warning');
      return;
    }
    const approxBytes = Math.floor((input.imageBase64.length * 3) / 4);
    if (approxBytes > MAX_GUEST_IMAGE_BYTES) {
      showToast('Your image is too large for guest access. Compress it or use BYOK mode.', 'warning');
      return;
    }
  }

  if (!State.turnstileToken) {
    if (DOM.guestStatusMessage) {
      DOM.guestStatusMessage.textContent = 'Please complete the verification challenge above before generating.';
      DOM.guestStatusMessage.classList.add('is-error');
    }
    showToast('Please complete the verification challenge, then try again.', 'warning');
    return;
  }

  const requestBody = {
    mode: State.selectedMode,
    inputType: input.inputType,
    subjectContext: State.focusSubjectContext,
    turnstileToken: State.turnstileToken
  };
  if (input.inputType === 'image') {
    requestBody.image = { data: input.imageBase64, mimeType: input.imageMimeType };
  } else {
    requestBody.text = input.text;
  }

  trackAnalyticsEvent('generation_started', { access_mode: 'guest', study_mode: State.selectedMode, input_type: input.inputType });
  setGenerationLoadingState(true);

  try {
    const res = await fetch('/api/generate-study-deck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    const payload = await res.json().catch(() => null);

    if (!res.ok || !payload || !payload.data) {
      const code = (payload && payload.error && payload.error.code) || 'UNKNOWN_ERROR';
      const extra = (payload && payload.error) || {};
      const message = guestErrorToUserMessage(code, extra);

      showToast(message, 'error', 6000);
      trackAnalyticsEvent('generation_failed', { access_mode: 'guest', failure_category: mapGuestErrorToFailureCategory(code) });

      if (code === 'GUEST_DAILY_LIMIT_REACHED') {
        State.guestUsageRemaining = 0;
        trackAnalyticsEvent('guest_quota_exhausted', {});
      }
      if (DOM.guestStatusMessage) {
        DOM.guestStatusMessage.textContent = message;
        DOM.guestStatusMessage.classList.add('is-error');
      }
      syncAccessModeUI();

      if (!State.activeDeckId) {
        setEmptyState();
      } else {
        loadDeck(State.activeDeckId);
      }
      return;
    }

    const parsedData = payload.data;
    const deckRecord = {
      id: 'deck_' + Date.now(),
      title: parsedData.title || 'Untitled Study Deck',
      subtitle: parsedData.subtitle || `Source: ${input.sourceContext}`,
      mode: State.selectedMode,
      data: parsedData,
      sourceType: input.inputType,
      accessMode: 'guest',
      timestamp: Date.now()
    };

    State.history.unshift(deckRecord);
    saveHistory();
    loadDeck(deckRecord.id);

    if (payload.usage && typeof payload.usage.remaining === 'number') {
      State.guestUsageRemaining = payload.usage.remaining;
    }
    if (DOM.guestStatusMessage) {
      DOM.guestStatusMessage.textContent = '';
      DOM.guestStatusMessage.classList.remove('is-error');
    }
    syncAccessModeUI();

    showToast('Study Card generated successfully!', 'success');
    trackAnalyticsEvent('generation_succeeded', { access_mode: 'guest', study_mode: State.selectedMode, input_type: input.inputType });
  } catch (err) {
    showToast('Network error while contacting the guest generation service. Please try again.', 'error', 6000);
    trackAnalyticsEvent('generation_failed', { access_mode: 'guest', failure_category: 'network' });
    if (!State.activeDeckId) {
      setEmptyState();
    } else {
      loadDeck(State.activeDeckId);
    }
  } finally {
    resetTurnstileWidget();
    setGenerationLoadingState(false);
  }
}

// Model used both as the existing hard-failure fallback and as the request
// target for a compact retry (compact retry always reuses the ORIGINALLY
// selected model, never this constant, unless they're already the same).
const BYOK_FALLBACK_MODEL = 'gemini-2.5-flash';

// Orchestrates a full BYOK generation, including the same call-policy cap
// as the Guest path: at most 2 total Gemini calls.
//   - If the first call throws (network/invalid key/quota/etc), try the
//     existing model-fallback ONCE — never also attempt a compact retry
//     after that (keeps the total at 2).
//   - If the first call succeeds but the content is truncated/malformed
//     specifically due to length, attempt ONE compact retry on the SAME
//     model instead of switching models — output-limit issues are a
//     length problem, not a reason to distrust the model choice.
// Throws an Error with `.responseIssue`/`.completion` set for content-level
// failures (safety block, malformed/invalid structure, empty, or a
// still-failing compact retry) so the caller can show an actionable message.
async function generateByokDeck({ ai, model, payloadObject, mode, subjectContext, sourceLength }) {
  const maxOutputTokens = getOutputTokenBudget(mode);
  const primaryModeConfig = buildModeConfig(mode, subjectContext, sourceLength);

  let firstResponse;
  let usedFallbackModel = false;
  try {
    firstResponse = await callGeminiSdk(ai, model, payloadObject, primaryModeConfig, maxOutputTokens);
  } catch (err) {
    if (model !== BYOK_FALLBACK_MODEL) {
      console.warn(`Primary model call to ${model} failed, testing fallback '${BYOK_FALLBACK_MODEL}'...`, err);
      firstResponse = await callGeminiSdk(ai, BYOK_FALLBACK_MODEL, payloadObject, primaryModeConfig, maxOutputTokens);
      usedFallbackModel = true;
    } else {
      throw err;
    }
  }

  const firstClassification = classifyGeneratedResponse({
    mode,
    text: extractSdkResponseText(firstResponse),
    finishReason: extractSdkFinishReason(firstResponse)
  });

  if (firstClassification.issue === RESPONSE_ISSUE.OK) {
    return { data: firstClassification.data, retried: false };
  }

  // A hard call-level fallback already happened for this generation — don't
  // also spend a compact retry (never exceed 2 total calls).
  if (usedFallbackModel || !isRetryableForLength(firstClassification.issue)) {
    throw responseIssueError(firstClassification);
  }

  const compactModeConfig = buildModeConfig(mode, subjectContext, sourceLength, { compact: true });
  const retryResponse = await callGeminiSdk(ai, model, payloadObject, compactModeConfig, maxOutputTokens);

  const retryClassification = classifyGeneratedResponse({
    mode,
    text: extractSdkResponseText(retryResponse),
    finishReason: extractSdkFinishReason(retryResponse)
  });

  if (retryClassification.issue === RESPONSE_ISSUE.OK) {
    return { data: retryClassification.data, retried: true };
  }

  throw responseIssueError(retryClassification);
}

function responseIssueError(classification) {
  const err = new Error(`model_response_issue:${classification.issue}`);
  err.responseIssue = classification.issue;
  err.completion = classification.completion;
  return err;
}

async function callGeminiSdk(ai, model, payloadObject, modeConfig, maxOutputTokens) {
  const { schema, systemInstruction, userPrompt } = modeConfig;
  const configObj = {
    responseMimeType: 'application/json',
    responseJsonSchema: schema,
    systemInstruction: systemInstruction,
    temperature: 0.2,
    maxOutputTokens
  };

  return await ai.models.generateContent({
    model: model,
    contents: [payloadObject, userPrompt],
    config: configObj
  });
}

// The @google/genai response exposes a `.text` convenience getter, but some
// SDK versions throw when accessing it on a response with no text parts
// (safety block, MAX_TOKENS with no output yet). Fall back to reading the
// candidate's parts directly — the same shape the Guest path reads from the
// REST API, so both paths classify responses identically.
function extractSdkResponseText(response) {
  try {
    if (response && typeof response.text === 'string') return response.text;
  } catch (err) {
    // Fall through to manual extraction below.
  }
  const candidate = response && Array.isArray(response.candidates) && response.candidates[0];
  const parts = candidate && candidate.content && candidate.content.parts;
  const textPart = Array.isArray(parts) ? parts.find(p => typeof p.text === 'string') : null;
  return textPart ? textPart.text : null;
}

function extractSdkFinishReason(response) {
  const candidate = response && Array.isArray(response.candidates) && response.candidates[0];
  return candidate && candidate.finishReason;
}

// --- Toggle Generation UI states ---
function setGenerationLoadingState(active) {
  State.isGenerating = active;
  
  if (active) {
    DOM.generateBtn.disabled = true;
    DOM.generateBtn.querySelector('span').textContent = 'Analyzing...';
    DOM.generateBtn.querySelector('.icon-sparkles').classList.add('spinning');
    
    DOM.cardEmptyState.style.display = 'none';
    DOM.cardContentWrapper.style.display = 'none';
    DOM.cardLoadingState.style.display = 'block';
    
    DOM.exportPngBtn.disabled = true;
    DOM.expandFullscreenBtn.disabled = true;
  } else {
    DOM.generateBtn.disabled = false;
    DOM.generateBtn.querySelector('span').textContent = 'Analyze & Generate';
    DOM.generateBtn.querySelector('.icon-sparkles').classList.remove('spinning');
    DOM.cardLoadingState.style.display = 'none';
  }
}

function setEmptyState() {
  DOM.cardEmptyState.style.display = 'flex';
  DOM.cardContentWrapper.style.display = 'none';
  DOM.cardLoadingState.style.display = 'none';
  DOM.deckTitleDisplay.textContent = 'Untitled Study Deck';
  DOM.exportPngBtn.disabled = true;
  DOM.expandFullscreenBtn.disabled = true;
  DOM.studyCard.classList.remove('is-truncated');
  State.activeDeckId = null;
}

// --- Dynamic History Library Grid Rendering ---
function renderHistory() {
  const container = DOM.historyList;
  container.innerHTML = '';
  
  if (State.history.length === 0) {
    container.innerHTML = `
      <div class="history-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <line x1="9" y1="9" x2="15" y2="9"></line>
          <line x1="9" y1="13" x2="15" y2="13"></line>
          <line x1="9" y1="17" x2="13" y2="17"></line>
        </svg>
        <h3>No Generated Decks Found</h3>
        <p>Go to the studio workstation above and generate cards to start building your offline study list.</p>
      </div>
    `;
    DOM.clearHistoryBtn.style.display = 'none';
    return;
  }
  
  DOM.clearHistoryBtn.style.display = 'inline-block';
  
  State.history.forEach(deck => {
    const card = document.createElement('div');
    card.className = 'library-item-card';
    if (deck.id === State.activeDeckId) card.classList.add('active');
    card.dataset.id = deck.id;
    
    const modeLabel = getModeLabel(deck.mode);
    const dateFormatted = new Date(deck.timestamp).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    
    card.innerHTML = `
      <div class="library-card-top">
        <span class="library-card-badge">${escapeHtml(modeLabel)}</span>
        <h4 class="library-card-title">${escapeHtml(deck.title)}</h4>
        <span class="library-card-meta">${escapeHtml(deck.subtitle)}</span>
      </div>
      <div class="library-card-actions">
        <span class="library-card-meta" style="margin-right: auto;">${dateFormatted}</span>
        <button class="lib-action-btn load" data-tooltip="Load into Workstation" aria-label="Load Deck">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
            <polyline points="15 3 21 3 21 9"></polyline>
            <polyline points="9 21 3 21 3 15"></polyline>
            <line x1="21" y1="3" x2="14" y2="10"></line>
            <line x1="3" y1="21" x2="10" y2="14"></line>
          </svg>
        </button>
        <button class="lib-action-btn delete" data-tooltip="Delete Card" aria-label="Delete Deck">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    `;
    
    // Clicking card triggers load and scrolls up smoothly to studio
    card.addEventListener('click', (e) => {
      if (e.target.closest('.delete') || e.target.closest('.lib-action-btn')) return;
      loadSavedDeck(deck.id);
    });
    
    card.querySelector('.load').addEventListener('click', (e) => {
      e.stopPropagation();
      loadSavedDeck(deck.id);
    });
    
    card.querySelector('.delete').addEventListener('click', (e) => {
      e.stopPropagation();
      handleDeleteHistoryItem(deck.id);
    });
    
    container.appendChild(card);
  });
}

function loadSavedDeck(deckId) {
  loadDeck(deckId);
  showToast('Study Card loaded in Studio.', 'success', 2000);
  const studioSec = document.getElementById('studio-section');
  if (studioSec) {
    studioSec.scrollIntoView({ behavior: 'smooth' });
  }
}

// --- Deck Rendering Engine ---
function loadDeck(deckId) {
  const deck = State.history.find(d => d.id === deckId);
  if (!deck) {
    setEmptyState();
    return;
  }
  
  State.activeDeckId = deckId;
  DOM.deckTitleDisplay.textContent = deck.title;
  DOM.studyCard.dataset.mode = deck.mode;
  
  // Highlight active deck card in the library
  document.querySelectorAll('.library-item-card').forEach(item => {
    if (item.dataset.id === deckId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });
  
  const contentWrapper = DOM.cardContentWrapper;
  contentWrapper.innerHTML = '';
  
  const headerHtml = `
    <div class="card-header">
      <div class="card-header-top">
        <h2 class="card-main-title">${escapeHtml(deck.title)}</h2>
        <span class="mode-badge">${escapeHtml(getModeLabel(deck.mode))}</span>
      </div>
      <div class="card-subheader">${escapeHtml(deck.subtitle)}</div>
    </div>
  `;
  
  let bodyHtml = '';
  const d = deck.data;
  
  if (deck.mode === 'summary') {
    let bullets = '<ul class="summary-bullets-list">';
    d.bullets.forEach(b => {
      bullets += `
        <li class="summary-bullet-item">
          <span class="bullet-label">${escapeHtml(b.label)}</span>
          <span class="bullet-text">${escapeHtml(b.content)}</span>
        </li>
      `;
    });
    bullets += '</ul>';
    
    const takeaway = `
      <div class="takeaway-container">
        <div class="takeaway-title">Core Takeaway</div>
        <div class="takeaway-text">${escapeHtml(d.takeaway)}</div>
      </div>
    `;
    bodyHtml = `<div class="card-body">${bullets}${takeaway}</div>`;
    
  } else if (deck.mode === 'eli5') {
    const analogy = `
      <div class="eli5-analogy-box">
        <div class="analogy-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
          <span>Analogy: ${escapeHtml(d.analogyTitle)}</span>
        </div>
        <div class="analogy-body">${escapeHtml(d.analogy)}</div>
      </div>
    `;
    
    const explanation = `
      <div class="eli5-explanation">
        ${escapeHtml(d.simpleExplanation)}
      </div>
    `;
    
    const funfact = `
      <div class="eli5-funfact">
        <div class="funfact-title">Fun Fact</div>
        <div class="funfact-body">${escapeHtml(d.funFact)}</div>
      </div>
    `;
    
    bodyHtml = `<div class="card-body">${analogy}${explanation}${funfact}</div>`;
    
  } else if (deck.mode === 'notes') {
    let sectionsHtml = '<div class="outline-sections-container">';
    d.sections.forEach(sec => {
      sectionsHtml += `
        <div class="outline-section">
          <h3 class="outline-section-header">${escapeHtml(sec.header)}</h3>
      `;
      
      sec.subsections.forEach(sub => {
        sectionsHtml += `
          <div class="outline-subsection">
            <h4 class="outline-subsection-header">${escapeHtml(sub.subHeader)}</h4>
            <ul class="outline-bullets-list">
        `;
        
        sub.bullets.forEach(b => {
          sectionsHtml += `
            <li class="outline-bullet-item">${escapeHtml(b)}</li>
          `;
        });
        
        sectionsHtml += `
            </ul>
          </div>
        `;
      });
      
      sectionsHtml += `</div>`; // Close outline-section
    });
    sectionsHtml += '</div>';
    
    bodyHtml = `<div class="card-body">${sectionsHtml}</div>`;
    
  } else if (deck.mode === 'flashcards') {
    let grid = '<div class="flashcards-grid">';
    d.cards.forEach((c, idx) => {
      grid += `
        <div class="flashcard-item" data-index="${idx}">
          <div class="flashcard-inner">
            <div class="flashcard-front">
              <span class="flashcard-role-label">Question ${idx + 1}</span>
              <p class="flashcard-text">${escapeHtml(c.question)}</p>
              <span class="flip-hint">Click to reveal</span>
            </div>
            <div class="flashcard-back">
              <span class="flashcard-role-label">Answer</span>
              <p class="flashcard-text">${escapeHtml(c.answer)}</p>
              <span class="flip-hint">Click to flip</span>
            </div>
          </div>
        </div>
      `;
    });
    grid += '</div>';
    bodyHtml = `<div class="card-body">${grid}</div>`;
  }
  
  const footerHtml = `
    <div class="card-footer">
      <span>Open Study Deck</span>
      <span>Zero Paywall AI Studio</span>
    </div>
  `;
  
  contentWrapper.innerHTML = headerHtml + bodyHtml + footerHtml;
  
  if (deck.mode === 'flashcards') {
    contentWrapper.querySelectorAll('.flashcard-item').forEach(card => {
      card.addEventListener('click', () => {
        card.classList.toggle('flipped');
      });
    });
  }
  
  DOM.cardEmptyState.style.display = 'none';
  DOM.cardLoadingState.style.display = 'none';
  DOM.cardContentWrapper.style.display = 'block';
  DOM.exportPngBtn.disabled = false;
  DOM.expandFullscreenBtn.disabled = false;

  // Clear any existing truncation first so we measure the natural scrollHeight
  DOM.studyCard.classList.remove('is-truncated');
  
  // Use scrollHeight of cardContentWrapper to check if the generated content is large
  const contentHeight = DOM.cardContentWrapper.scrollHeight;
  if (contentHeight > 450) {
    DOM.studyCard.classList.add('is-truncated');
  }
}

function handleDeleteHistoryItem(id) {
  State.history = State.history.filter(item => item.id !== id);
  saveHistory();
  showToast('Study Card deleted from local history.', 'info');
  
  if (State.activeDeckId === id) {
    if (State.history.length > 0) {
      loadDeck(State.history[0].id);
    } else {
      setEmptyState();
    }
  }
}

function handleClearAllHistory() {
  if (confirm('Are you sure you want to clear your local generation history? This action is irreversible.')) {
    State.history = [];
    saveHistory();
    setEmptyState();
    showToast('Cleared all local study card records.', 'info');
  }
}

// --- Reusable PNG export helper ---
async function exportElementToPng(targetElement, title, mode) {
  showToast('Exporting card as high-resolution PNG...', 'info');
  
  const flippedCards = targetElement.querySelectorAll('.flashcard-item.flipped');
  flippedCards.forEach(c => c.classList.remove('flipped'));
  
  await new Promise(resolve => setTimeout(resolve, 300));
  
  const canvasConfig = {
    scale: 2.5, // Crisp 2.5x upscale
    useCORS: true,
    backgroundColor: null,
    scrollX: 0,
    scrollY: 0,
    windowWidth: document.documentElement.offsetWidth,
    windowHeight: document.documentElement.offsetHeight,
    onclone: (clonedDoc) => {
      const canvasClone = clonedDoc.querySelector('.card-canvas');
      if (canvasClone) {
        canvasClone.style.boxShadow = 'none';
      }
      const studyCardClone = clonedDoc.querySelector('.study-card');
      if (studyCardClone) {
        studyCardClone.classList.remove('is-truncated');
      }
    }
  };
  
  try {
    const canvas = await window.html2canvas(targetElement, canvasConfig);
    const dataUrl = canvas.toDataURL('image/png');
    
    const downloadLink = document.createElement('a');
    const sanitizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    downloadLink.download = `OpenStudyDeck-${sanitizedTitle}-${mode}.png`;
    downloadLink.href = dataUrl;
    
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);

    showToast('PNG Card exported successfully!', 'success');
    trackAnalyticsEvent('deck_exported', { export_type: 'png', study_mode: mode });
  } catch (err) {
    console.error('HTML2Canvas export failed:', err);
    showToast('Export failed. Please try again.', 'error');
  } finally {
    flippedCards.forEach(c => c.classList.add('flipped'));
  }
}

// --- html2canvas PNG export ---
async function handlePngExport() {
  const activeDeck = State.history.find(d => d.id === State.activeDeckId);
  if (!activeDeck) {
    showToast('No active deck to export.', 'warning');
    return;
  }
  
  DOM.exportPngBtn.disabled = true;
  try {
    await exportElementToPng(DOM.cardCanvas, activeDeck.title, activeDeck.mode);
  } finally {
    DOM.exportPngBtn.disabled = false;
  }
}

// --- Full Screen Modal PNG Export ---
async function handleFullscreenPngExport() {
  const activeDeck = State.history.find(d => d.id === State.activeDeckId);
  if (!activeDeck) return;
  const cloneCanvas = document.getElementById('fullscreen-card-canvas');
  if (!cloneCanvas) return;
  
  const downloadBtn = document.getElementById('fullscreen-download-png');
  downloadBtn.disabled = true;
  try {
    await exportElementToPng(cloneCanvas, activeDeck.title, activeDeck.mode);
  } finally {
    downloadBtn.disabled = false;
  }
}

// --- Full Screen View Handler ---
function openFullscreenView() {
  const activeDeck = State.history.find(d => d.id === State.activeDeckId);
  if (!activeDeck) return;
  
  const modal = document.getElementById('fullscreen-modal');
  const container = document.getElementById('fullscreen-canvas-container');
  if (!modal || !container) return;
  
  container.innerHTML = '';
  
  // Clone the canvas
  const canvasClone = DOM.cardCanvas.cloneNode(true);
  canvasClone.id = 'fullscreen-card-canvas';
  
  // Remove truncation class from study-card clone so it displays in full height
  const studyCardClone = canvasClone.querySelector('.study-card');
  if (studyCardClone) {
    studyCardClone.classList.remove('is-truncated');
  }
  
  // Re-attach card flip listeners on the clone
  canvasClone.querySelectorAll('.flashcard-item').forEach(card => {
    card.addEventListener('click', () => {
      card.classList.toggle('flipped');
    });
  });
  
  container.appendChild(canvasClone);
  modal.style.display = 'flex';
}

// --- Text Document (Markdown) Export ---
function handleTextDownload() {
  const activeDeck = State.history.find(d => d.id === State.activeDeckId);
  if (!activeDeck) return;
  
  let mdText = `# ${activeDeck.title}\n`;
  if (activeDeck.subtitle) {
    mdText += `## ${activeDeck.subtitle}\n\n`;
  }
  
  const modeLabel = getModeLabel(activeDeck.mode);
  mdText += `Study Mode: ${modeLabel}\n`;
  mdText += `Generated via Open Study Deck\n`;
  mdText += `========================================\n\n`;
  
  const d = activeDeck.data;
  if (activeDeck.mode === 'summary') {
    d.bullets.forEach((b, idx) => {
      mdText += `${idx + 1}. **${b.label}**: ${b.content}\n`;
    });
    mdText += `\n### Core Takeaway\n${d.takeaway}\n`;
  } else if (activeDeck.mode === 'eli5') {
    mdText += `### Analogy: ${d.analogyTitle}\n${d.analogy}\n\n`;
    mdText += `### Simple Explanation\n${d.simpleExplanation}\n\n`;
    mdText += `### Fun Fact\n${d.funFact}\n`;
  } else if (activeDeck.mode === 'notes') {
    d.sections.forEach(sec => {
      mdText += `### ${sec.header}\n\n`;
      sec.subsections.forEach(sub => {
        mdText += `#### ${sub.subHeader}\n`;
        sub.bullets.forEach(b => {
          mdText += `* ${b}\n`;
        });
        mdText += `\n`;
      });
    });
  } else if (activeDeck.mode === 'flashcards') {
    d.cards.forEach((c, idx) => {
      mdText += `Card ${idx + 1}\n`;
      mdText += `Question: ${c.question}\n`;
      mdText += `Answer: ${c.answer}\n`;
      mdText += `----------------------------------------\n\n`;
    });
  }
  
  const blob = new Blob([mdText], { type: 'text/markdown;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  
  const downloadLink = document.createElement('a');
  const sanitizedTitle = activeDeck.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  downloadLink.download = `OpenStudyDeck-${sanitizedTitle}-${activeDeck.mode}.md`;
  downloadLink.href = url;
  
  document.body.appendChild(downloadLink);
  downloadLink.click();
  document.body.removeChild(downloadLink);
  URL.revokeObjectURL(url);

  showToast('Text Document exported successfully!', 'success');
  trackAnalyticsEvent('deck_exported', { export_type: 'markdown', study_mode: activeDeck.mode });
}

// --- Modal Handlers ---
function initModalHandlers() {
  const apiModal = document.getElementById('api-modal');
  const supportModal = document.getElementById('support-modal');
  const fullscreenModal = document.getElementById('fullscreen-modal');
  const closeFullscreenModal = document.getElementById('close-fullscreen-modal');
  
  // Open Triggers
  document.getElementById('api-modal-trigger').addEventListener('click', () => {
    apiModal.style.display = 'flex';
    syncApiKeyUI();
    const modalInput = document.getElementById('api-key-input-modal');
    if (modalInput) modalInput.focus();
  });
  
  document.getElementById('support-modal-trigger').addEventListener('click', () => {
    supportModal.style.display = 'flex';
  });
  
  // settings donation trigger
  const settingsDonateBtn = document.getElementById('settings-donate-btn');
  if (settingsDonateBtn) {
    settingsDonateBtn.addEventListener('click', () => {
      supportModal.style.display = 'flex';
    });
  }
  
  // Close buttons
  document.getElementById('close-api-modal').addEventListener('click', () => {
    apiModal.style.display = 'none';
  });
  
  document.getElementById('close-support-modal').addEventListener('click', () => {
    supportModal.style.display = 'none';
  });
  
  if (closeFullscreenModal) {
    closeFullscreenModal.addEventListener('click', () => {
      fullscreenModal.style.display = 'none';
    });
  }
  
  // Click overlay to close
  [apiModal, supportModal, fullscreenModal].forEach(modal => {
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.style.display = 'none';
        }
      });
    }
  });

  const fullscreenDownloadPng = document.getElementById('fullscreen-download-png');
  if (fullscreenDownloadPng) {
    fullscreenDownloadPng.addEventListener('click', handleFullscreenPngExport);
  }
  
  const fullscreenDownloadText = document.getElementById('fullscreen-download-text');
  if (fullscreenDownloadText) {
    fullscreenDownloadText.addEventListener('click', handleTextDownload);
  }
}

// --- Dark Mode / Light Mode Theme Toggle Handler ---
function initThemeToggle() {
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  if (!themeToggleBtn) return;
  
  const sunIcon = themeToggleBtn.querySelector('.sun-icon');
  const moonIcon = themeToggleBtn.querySelector('.moon-icon');
  
  // Load saved preference or default to system dark preference
  let savedThemeMode = localStorage.getItem('openstudydeck_theme_mode');
  
  if (!savedThemeMode) {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    savedThemeMode = prefersDark ? 'dark' : 'light';
  }
  
  if (savedThemeMode === 'dark') {
    document.body.classList.add('dark-mode');
    sunIcon.style.display = 'block';
    moonIcon.style.display = 'none';
  } else {
    document.body.classList.remove('dark-mode');
    sunIcon.style.display = 'none';
    moonIcon.style.display = 'block';
  }
  
  themeToggleBtn.addEventListener('click', () => {
    const isDark = document.body.classList.toggle('dark-mode');
    if (isDark) {
      localStorage.setItem('openstudydeck_theme_mode', 'dark');
      sunIcon.style.display = 'block';
      moonIcon.style.display = 'none';
      showToast('Dark mode enabled', 'success', 1500);
    } else {
      localStorage.setItem('openstudydeck_theme_mode', 'light');
      sunIcon.style.display = 'none';
      moonIcon.style.display = 'block';
      showToast('Light mode enabled', 'success', 1500);
    }
  });
}

// --- Utilities ---
function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
