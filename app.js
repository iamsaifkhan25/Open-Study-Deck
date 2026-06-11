/* ==========================================================================
   OPEN STUDY DECK - APPLICATION CONTROLLER (ES MODULE)
   ========================================================================== */

import { GoogleGenAI } from 'https://cdn.jsdelivr.net/npm/@google/genai/+esm';

// --- Application State ---
const State = {
  apiKey: '',
  activeTab: 'image', // 'image' | 'text'
  uploadedImageBase64: null,
  uploadedImageMimeType: null,
  uploadedImageFileName: null,
  selectedMode: 'summary', // 'summary' | 'eli5' | 'flashcards'
  selectedTheme: 'aura-mesh', // 'aura-mesh' | 'cyber-midnight' | 'sunset-glow' | 'minimal-grid'
  selectedModel: 'gemini-2.5-flash',
  focusSubjectContext: '',
  isGenerating: false,
  history: [],
  activeDeckId: null
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
  systemContextInput: document.getElementById('system-context-input'),
  
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
  initSupportHandlers();
  
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
  State.apiKey = localStorage.getItem('openstudydeck_api_key') || '';
  if (State.apiKey) {
    DOM.apiKeyInput.value = State.apiKey;
    const modalInput = document.getElementById('api-key-input-modal');
    if (modalInput) modalInput.value = State.apiKey;
  }
  
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
    
    if (State.apiKey && State.apiKey.trim().length >= 8) {
      dot.className = 'status-dot dot-green';
      text.textContent = 'Key Active (BYOK)';
    } else {
      dot.className = 'status-dot dot-red';
      text.textContent = 'Key Required';
    }
  });
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
      const inputEl = document.getElementById(sourceInputId);
      if (inputEl) saveApiKey(inputEl.value.trim());
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

  // Handle keyboard submission on both inputs
  [DOM.apiKeyInput, document.getElementById('api-key-input-modal')].forEach(input => {
    if (input) {
      input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') saveApiKey(input.value.trim());
      });
    }
  });
  
  // 2. Input Tab Controls
  DOM.tabImage.addEventListener('click', () => switchInputTab('image'));
  DOM.tabText.addEventListener('click', () => switchInputTab('text'));
  
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
function saveApiKey(value) {
  if (!value || value.trim().length < 8) {
    showToast('Please enter a valid API key (minimum 8 characters).', 'warning');
    return;
  }
  
  State.apiKey = value;
  localStorage.setItem('openstudydeck_api_key', value);
  
  // Sync both input fields
  DOM.apiKeyInput.value = value;
  const modalInput = document.getElementById('api-key-input-modal');
  if (modalInput) modalInput.value = value;
  
  checkApiStatus();
  showToast('Gemini API key saved securely locally.', 'success');
  
  // Close modal if open
  document.getElementById('api-modal').style.display = 'none';
}

function clearApiKey() {
  State.apiKey = '';
  localStorage.removeItem('openstudydeck_api_key');
  
  // Clear both input fields
  DOM.apiKeyInput.value = '';
  const modalInput = document.getElementById('api-key-input-modal');
  if (modalInput) modalInput.value = '';
  
  checkApiStatus();
  showToast('API key removed from local storage.', 'info');
  
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

// --- Input Tab Navigation ---
function switchInputTab(tabType) {
  State.activeTab = tabType;
  
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
async function handleGenerateDeck() {
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
  
  let sourceContext = '';
  let payloadObject = null;
  
  if (State.activeTab === 'image') {
    if (!State.uploadedImageBase64) {
      showToast('Please upload or drag an image containing textbooks/notes.', 'warning');
      return;
    }
    payloadObject = {
      inlineData: {
        data: State.uploadedImageBase64,
        mimeType: State.uploadedImageMimeType
      }
    };
    sourceContext = `${State.uploadedImageFileName}`;
  } else {
    const rawText = DOM.textInputField.value.trim();
    if (!rawText) {
      showToast('Please paste notes, textbooks excerpts, or links in the text workstation.', 'warning');
      DOM.textInputField.focus();
      return;
    }
    payloadObject = rawText;
    sourceContext = rawText.length > 30 ? rawText.substring(0, 27) + '...' : rawText;
  }
  
  const checkedMode = document.querySelector('input[name="study-mode"]:checked');
  State.selectedMode = checkedMode ? checkedMode.value : 'summary';
  
  const { schema, systemInstruction, userPrompt } = getModeConfig(State.selectedMode, State.focusSubjectContext);
  
  setGenerationLoadingState(true);
  
  try {
    const ai = new GoogleGenAI({ apiKey: State.apiKey });
    const contents = [payloadObject, userPrompt];
    const response = await executeWithFallback(ai, State.selectedModel, contents, schema, systemInstruction);
    const parsedData = JSON.parse(response.text);
    
    const deckRecord = {
      id: 'deck_' + Date.now(),
      title: parsedData.title || 'Untitled Study Deck',
      subtitle: parsedData.subtitle || `Source: ${sourceContext}`,
      mode: State.selectedMode,
      data: parsedData,
      sourceType: State.activeTab,
      timestamp: Date.now()
    };
    
    State.history.unshift(deckRecord);
    saveHistory();
    loadDeck(deckRecord.id);
    
    showToast('Study Card generated successfully!', 'success');
  } catch (err) {
    console.error('Gemini API Error:', err);
    let errorMsg = 'Failed to analyze contents. ';
    
    if (err.message) {
      if (err.message.includes('API key') || err.message.includes('400')) {
        errorMsg += 'Invalid API Key. Please verify settings.';
      } else if (err.message.includes('Quota') || err.message.includes('429')) {
        errorMsg += 'Request limit exceeded. Please wait a minute before retrying.';
      } else {
        errorMsg += err.message;
      }
    } else {
      errorMsg += 'Network failure or API server error.';
    }
    
    showToast(errorMsg, 'error', 6000);
    
    if (!State.activeDeckId) {
      setEmptyState();
    } else {
      loadDeck(State.activeDeckId);
    }
  } finally {
    setGenerationLoadingState(false);
  }
}

async function executeWithFallback(ai, model, contents, schema, systemInstruction) {
  const configObj = {
    responseMimeType: 'application/json',
    responseJsonSchema: schema,
    systemInstruction: systemInstruction,
    temperature: 0.2
  };
  
  try {
    return await ai.models.generateContent({
      model: model,
      contents: contents,
      config: configObj
    });
  } catch (err) {
    console.warn(`Primary model call to ${model} failed, testing fallback 'gemini-2.5-flash'...`, err);
    if (model !== 'gemini-2.5-flash') {
      return await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: contents,
        config: configObj
      });
    }
    throw err;
  }
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

// --- Modes Configs and Prompts ---
function getModeConfig(mode, academicSubject = '') {
  const subjectPrefix = academicSubject ? `Focus context specifically on the subject: ${academicSubject}. ` : '';
  
  let schema = {};
  let systemInstruction = '';
  let userPrompt = '';
  
  if (mode === 'summary') {
    schema = {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Catchy study card title' },
        subtitle: { type: 'string', description: 'Brief subject classification' },
        bullets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Core concept term (2-5 words max)' },
              content: { type: 'string', description: 'Insights detailing the concept (1-2 sentences maximum)' }
            },
            required: ['label', 'content']
          }
        },
        takeaway: { type: 'string', description: 'A single high-impact takeaway sentence' }
      },
      required: ['title', 'subtitle', 'bullets', 'takeaway']
    };
    
    systemInstruction = `You are a professional educational designer and summarization engine. ${subjectPrefix}Analyze the study source text/image. Generate a high-yield study summary that extracts critical terms. Keep definitions to-the-point. Format output STRICTLY as JSON adhering to the provided schema.`;
    userPrompt = `Perform a high-yield summary of the uploaded study reference material. Extract between 3 and 5 key concepts. Keep content academic, clear, and educational.`;
    
  } else if (mode === 'eli5') {
    schema = {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Sleek explanation title' },
        subtitle: { type: 'string', description: 'Topic context' },
        analogyTitle: { type: 'string', description: 'Title of the analogy used' },
        analogy: { type: 'string', description: 'A highly relatable analogy mapping the topic to simple concepts that a 5-year-old understands' },
        simpleExplanation: { type: 'string', description: 'A explanation of the core mechanics written in simple, clear language without using heavy terminology.' },
        funFact: { type: 'string', description: 'An engaging, fun, or memorable trivia fact related to the topic.' }
      },
      required: ['title', 'subtitle', 'analogyTitle', 'analogy', 'simpleExplanation', 'funFact']
    };
    
    systemInstruction = `You are a master scientific communicator and school tutor. ${subjectPrefix}Analyze the provided study material and translate it into a simple explanation suitable for a child (ELI5 mode). Avoid technical terminology. Adhere strictly to the JSON schema.`;
    userPrompt = `Explain this concept like I am 5 years old. Use a playful, understandable analogy and clear language.`;
    
  } else { // flashcards
    schema = {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Study card deck name' },
        subtitle: { type: 'string', description: 'Context and scope' },
        cards: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'A clear, direct test question testing key principles' },
              answer: { type: 'string', description: 'The accurate, precise answer (1-2 sentences max)' }
            },
            required: ['question', 'answer']
          }
        }
      },
      required: ['title', 'subtitle', 'cards']
    };
    
    systemInstruction = `You are an academic flashcard creator. ${subjectPrefix}Analyze the material and formulate precise Q&A flashcards for study revisions. Avoid multiple choice. Keep questions clean and answers compact. Adhere strictly to the JSON schema.`;
    userPrompt = `Extract exactly 4 high-yield Q&A study flashcards from the provided resource. Focus on core details, dates, equations, or processes.`;
  }
  
  return { schema, systemInstruction, userPrompt };
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

function getModeLabel(mode) {
  if (mode === 'summary') return 'Summary Bullets';
  if (mode === 'eli5') return 'ELI5 Simplification';
  if (mode === 'flashcards') return 'Q&A Flashcards';
  return 'Study Deck';
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
    // Load local storage value fresh into modal input
    const modalInput = document.getElementById('api-key-input-modal');
    if (modalInput) {
      modalInput.value = State.apiKey;
      modalInput.focus();
    }
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

// --- Load Razorpay Script Dynamically ---
const loadRazorpay = () => {
  return new Promise((resolve) => {
    if (window.Razorpay) {
      resolve(true);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
};

// --- Support Donation Tiers Form Handler ---
function initSupportHandlers() {
  const customRadio = document.getElementById('opt-custom');
  const customInput = document.getElementById('custom-support-amount');
  const allRadios = document.querySelectorAll('input[name="support-tier"]');
  const submitBtn = document.getElementById('submit-support-btn');
  const messageArea = document.getElementById('support-message');
  
  const customAmountGroup = document.getElementById('custom-amount-group');

  allRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      if (customRadio.checked) {
        if (customAmountGroup) customAmountGroup.style.display = 'block';
        if (!customInput.value) {
          customInput.value = '20'; // set default value to prevent empty redirects
        }
        customInput.focus();
        customInput.select(); // auto-select value so typing replaces it
      } else {
        if (customAmountGroup) customAmountGroup.style.display = 'none';
        customInput.value = '';
      }
    });
  });
  
  submitBtn.addEventListener('click', async () => {
    let amount = 0;
    
    if (customRadio.checked) {
      amount = parseFloat(customInput.value.trim());
      if (isNaN(amount) || amount <= 0) {
        showToast('Please enter a valid donation amount (e.g. 5, 20).', 'warning');
        customInput.focus();
        return;
      }
    } else {
      const selectedRadio = document.querySelector('input[name="support-tier"]:checked');
      amount = parseFloat(selectedRadio.value);
    }
    
    const message = messageArea.value.trim();
    
    const originalText = submitBtn.innerText;
    submitBtn.disabled = true;
    submitBtn.innerText = 'Initializing...';

    try {
      const isLoaded = await loadRazorpay();
      if (!isLoaded) {
        showToast('Failed to load Razorpay payment gateway. Please check your internet connection.', 'error');
        submitBtn.disabled = false;
        submitBtn.innerText = originalText;
        return;
      }

      const centsAmount = Math.round(amount * 100);
      const orderRes = await fetch('/api/create-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          amount: centsAmount,
          currency: 'USD'
        })
      });

      if (!orderRes.ok) {
        throw new Error('Failed to initiate order');
      }

      const orderData = await orderRes.json();
      if (orderData.error) {
        throw new Error(orderData.error);
      }

      const options = {
        key: orderData.razorpayKeyId,
        amount: orderData.amount,
        currency: orderData.currency,
        name: 'Open Study Deck',
        description: 'Support the Creator',
        order_id: orderData.id,
        handler: function (response) {
          showToast(`Thank you! Payment of $${amount} USD processed successfully.`, 'success', 5000);
          
          if (message) {
            setTimeout(() => {
              const mailtoSubject = `Support Message for Open Study Deck ($${amount})`;
              const mailtoBody = `Hi! I have contributed $${amount} USD via Razorpay to support Open Study Deck.\n\nMessage:\n${message}\n\nPayment ID: ${response.razorpay_payment_id}`;
              const mailtoUrl = `mailto:harukiwaves@zohomail.in?subject=${encodeURIComponent(mailtoSubject)}&body=${encodeURIComponent(mailtoBody)}`;
              window.location.href = mailtoUrl;
            }, 1000);
          }

          // Reset form states
          document.getElementById('support-modal').style.display = 'none';
          messageArea.value = '';
          customInput.value = '';
          if (customAmountGroup) customAmountGroup.style.display = 'none';
          document.getElementById('opt-coffee').checked = true;
          submitBtn.disabled = false;
          submitBtn.innerText = originalText;
        },
        prefill: {
          name: '',
          email: '',
          contact: ''
        },
        theme: {
          color: '#18181b'
        },
        modal: {
          ondismiss: function () {
            submitBtn.disabled = false;
            submitBtn.innerText = originalText;
          }
        }
      };

      const rzp = new window.Razorpay(options);
      rzp.open();
      submitBtn.innerText = 'In Progress...';
    } catch (err) {
      console.error(err);
      showToast('Payment initialization failed. Please try again.', 'error');
      submitBtn.disabled = false;
      submitBtn.innerText = originalText;
    }
  });
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
