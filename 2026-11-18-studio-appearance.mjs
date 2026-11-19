const preferenceKey = 'studioTheme';
const documentRoot = document.documentElement;
const toggle = document.getElementById('themeToggle');
const mark = document.getElementById('studioMark');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
let scenePromise;
let resetTransitionFrame = 0;

function syncTheme(theme) {
  const dark = theme !== 'light';
  const nextTheme = dark ? 'dark' : 'light';
  if (documentRoot.dataset.theme !== nextTheme) {
    documentRoot.classList.add('theme-switching');
    documentRoot.dataset.theme = nextTheme;
    cancelAnimationFrame(resetTransitionFrame);
    resetTransitionFrame = requestAnimationFrame(() => {
      resetTransitionFrame = requestAnimationFrame(() => documentRoot.classList.remove('theme-switching'));
    });
  }
  toggle.setAttribute('aria-pressed', String(dark));
  toggle.title = dark ? '라이트 모드로 전환' : '다크 모드로 전환';
  if (scenePromise) {
    void scenePromise.then(scene => scene?.render(dark));
  } else if (!mark.querySelector('img') && !reducedMotion.matches && document.visibilityState === 'visible') {
    scenePromise = import('./2026-11-18-studio-scene.mjs')
      .then(({ createStudioScene }) => createStudioScene(mark, reducedMotion, finePointer))
      .catch(() => null);
    void scenePromise.then(scene => scene?.render(documentRoot.dataset.theme === 'dark'));
  }
}

toggle.addEventListener('click', () => {
  const theme = documentRoot.dataset.theme === 'dark' ? 'light' : 'dark';
  syncTheme(theme);
  void chrome.storage.local.set({ [preferenceKey]: theme }).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[preferenceKey]) {
    syncTheme(changes[preferenceKey].newValue);
  }
});

function refreshAppearance() {
  syncTheme(documentRoot.dataset.theme);
}
reducedMotion.addEventListener('change', refreshAppearance);
document.addEventListener('visibilitychange', refreshAppearance);

void chrome.storage.local.get(preferenceKey)
  .then(settings => syncTheme(settings[preferenceKey]))
  .catch(refreshAppearance);

const navigation = document.querySelector('.workflow');
const links = [...navigation.querySelectorAll('a')];
const sections = links.map(link => document.getElementById(link.hash.slice(1)));
let frame = 0;

function updateCurrentStep() {
  const scrollOffset = parseFloat(getComputedStyle(sections[0]).scrollMarginTop) || 0;
  const line = Math.max(navigation.getBoundingClientRect().bottom + 16, scrollOffset + 2);
  let current = 0;
  for (const [index, section] of sections.entries()) {
    if (section.getBoundingClientRect().top <= line) current = index;
  }
  for (const [index, link] of links.entries()) {
    if (index === current) link.setAttribute('aria-current', 'step');
    else link.removeAttribute('aria-current');
  }
}

function scheduleCurrentStep() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (navigation.offsetWidth) updateCurrentStep();
  });
}

window.addEventListener('scroll', scheduleCurrentStep, { passive: true });
window.addEventListener('resize', scheduleCurrentStep);
new ResizeObserver(scheduleCurrentStep).observe(document.querySelector('main'));
for (const [index, link] of links.entries()) {
  link.addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const section = sections[index];
    section.focus({ preventScroll: true });
    section.scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start' });
  });
}
scheduleCurrentStep();
