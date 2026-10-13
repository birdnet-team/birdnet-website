/**
 * BirdNET Internationalization (i18n) Module
 * Handles language detection, persistence, and DOM translation
 */
(function () {
  'use strict';

  const DEFAULT_LANG = 'en';
  const SUPPORTED_LANGS = ['en', 'de', 'es', 'fr', 'it', 'pt-BR', 'pt', 'ru', 'pl', 'cs', 'zh-CN', 'tlh'];
  const STORAGE_KEY = 'birdnet-lang';

  let translations = {};
  let currentLang = DEFAULT_LANG;

  /**
   * Detect the preferred language from URL, localStorage, or browser settings
   */
  function detectLanguage() {
    // 1. Check URL parameter (?lang=de)
    const urlParams = new URLSearchParams(window.location.search);
    const urlLang = urlParams.get('lang');
    if (urlLang && SUPPORTED_LANGS.includes(urlLang)) {
      return urlLang;
    }

    // 2. Check localStorage
    const storedLang = localStorage.getItem(STORAGE_KEY);
    if (storedLang && SUPPORTED_LANGS.includes(storedLang)) {
      return storedLang;
    }

    // 3. Check browser language (try full locale first, e.g. zh-CN, then base language)
    const fullLang = navigator.language;
    if (fullLang && SUPPORTED_LANGS.includes(fullLang)) {
      return fullLang;
    }
    const baseLang = fullLang?.split('-')[0];
    if (baseLang && SUPPORTED_LANGS.includes(baseLang)) {
      return baseLang;
    }

    // 4. Fallback to default
    return DEFAULT_LANG;
  }

  /**
   * Update the URL with the current language parameter (without reload)
   */
  function updateUrlParam(lang) {
    const url = new URL(window.location);
    if (lang === DEFAULT_LANG) {
      url.searchParams.delete('lang');
    } else {
      url.searchParams.set('lang', lang);
    }
    window.history.replaceState({}, '', url);
  }

  /**
   * Load translation file for the specified language
   * English uses the original text in the HTML, so no translations needed
   */
  async function loadTranslations(lang) {
    // English is the default - original HTML content is already in English
    if (lang === DEFAULT_LANG) {
      return {};
    }
    
    // Load from inline embedded data for other languages
    if (window.__i18n && window.__i18n[lang]) {
      return window.__i18n[lang];
    }
    
    console.warn(`i18n: Could not load ${lang} translations`);
    // Fallback: return empty object (original text will show)
    return {};
  }

  /**
   * Get a translation by key with optional interpolation
   */
  function t(key, params = {}) {
    let text = translations[key] || key;
    
    // Simple interpolation: replace {key} with value
    Object.keys(params).forEach(param => {
      text = text.replace(new RegExp(`\\{${param}\\}`, 'g'), params[param]);
    });
    
    return text;
  }

  /**
   * Translate all elements with data-i18n attribute
   */
  function translatePage() {
    // Translate text content (supports [html] prefix for innerHTML)
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const rawKey = el.getAttribute('data-i18n');
      
      // Check for [html] prefix
      const isHtml = rawKey.startsWith('[html]');
      const key = isHtml ? rawKey.slice(6) : rawKey;
      
      const translated = t(key, { year: new Date().getFullYear() });
      if (translated !== key) {
        if (isHtml) {
          el.innerHTML = translated;
        } else {
          el.textContent = translated;
        }
      }
    });

    // Translate placeholders
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const translated = t(key);
      if (translated !== key) {
        el.placeholder = translated;
      }
    });

    // Translate titles/tooltips
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      const translated = t(key);
      if (translated !== key) {
        el.title = translated;
      }
    });

    // Translate aria-labels
    document.querySelectorAll('[data-i18n-aria]').forEach(el => {
      const key = el.getAttribute('data-i18n-aria');
      const translated = t(key);
      if (translated !== key) {
        el.setAttribute('aria-label', translated);
      }
    });

    // Translate image alt texts
    document.querySelectorAll('[data-i18n-alt]').forEach(el => {
      const key = el.getAttribute('data-i18n-alt');
      const translated = t(key);
      if (translated !== key) {
        el.setAttribute('alt', translated);
      }
    });

    // Update HTML lang attribute
    document.documentElement.lang = currentLang;

    // Update language switcher active state
    updateLanguageSwitcher();
  }

  /**
   * Update the language switcher UI to show current language
   */
  function updateLanguageSwitcher() {
    const switcher = document.getElementById('language-switcher');
    if (!switcher) return;

    // Update the dropdown button text
    const btn = switcher.querySelector('.dropdown-toggle');
    if (btn) {
      const langNames = { en: 'EN', de: 'DE', es: 'ES', fr: 'FR', it: 'IT', 'pt-BR': 'PT-BR', pt: 'PT', ru: 'RU', pl: 'PL', cs: 'CS', 'zh-CN': '中文', tlh: 'tlhIngan' };
      btn.innerHTML = `<i class="bi bi-globe2 me-1"></i>${langNames[currentLang] || currentLang.toUpperCase()}`;
    }

    // Update active state in dropdown items
    switcher.querySelectorAll('[data-lang]').forEach(item => {
      const lang = item.getAttribute('data-lang');
      item.classList.toggle('active', lang === currentLang);
    });
  }

  /**
   * Change the current language
   * Reloads the page to ensure clean state (original HTML is in English)
   */
  async function setLanguage(lang) {
    if (!SUPPORTED_LANGS.includes(lang)) {
      console.warn(`i18n: Unsupported language "${lang}"`);
      return;
    }

    if (lang === currentLang) {
      return; // Already on this language
    }

    // Store the new language preference
    localStorage.setItem(STORAGE_KEY, lang);
    
    // Update URL and reload to get fresh HTML
    // This is needed because English content comes from the original HTML,
    // not from a translations file
    const url = new URL(window.location);
    if (lang === DEFAULT_LANG) {
      url.searchParams.delete('lang');
    } else {
      url.searchParams.set('lang', lang);
    }
    window.location.href = url.toString();
  }

  /**
   * Initialize the i18n system
   */
  async function init() {
    const detectedLang = detectLanguage();
    currentLang = detectedLang;
    
    // Store the choice if it came from URL or browser detection
    localStorage.setItem(STORAGE_KEY, detectedLang);
    updateUrlParam(detectedLang);

    translations = await loadTranslations(detectedLang);
    
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', translatePage);
    } else {
      translatePage();
    }

    // Set up language switcher click handlers
    document.addEventListener('click', (e) => {
      const langItem = e.target.closest('[data-lang]');
      if (langItem) {
        e.preventDefault();
        const lang = langItem.getAttribute('data-lang');
        setLanguage(lang);
      }
    });
  }

  // Expose API globally
  window.i18n = {
    t,
    setLanguage,
    getCurrentLang: () => currentLang,
    getSupportedLangs: () => [...SUPPORTED_LANGS],
    translatePage
  };

  // Auto-initialize
  init();
})();
