import { ipcRenderer } from 'electron';

// This isolated preload exposes no bridge or Node capabilities to the official site.
let quick = false;
let composing = false;
let autoCollapsed = false;
let focusPending = false;
const handledThinking = new WeakSet<HTMLElement>();
let lastProbe = '';
let probeTimer: ReturnType<typeof setTimeout> | undefined;
let newChatTimer: ReturnType<typeof setTimeout> | undefined;
const visible = (el: Element | null): el is HTMLElement => {
  if (!el || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
};
const composer = () => Array.from(document.querySelectorAll<HTMLElement>('textarea, #chat-input, [contenteditable="true"][role="textbox"], [contenteditable="true"][data-placeholder]')).find(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
const label = (el: Element) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-tooltip-content'), el.textContent].filter(Boolean).join(' ').trim();
const buttons = () => Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], a, [tabindex="0"]')).filter(visible);
// Official controls currently lack accessible names. These SVG signatures were
// inspected on chat.deepseek.com; semantic names remain the preferred adapter.
const hasIcon = (el: Element, prefixes: string[]) => Array.from(el.querySelectorAll('svg path')).some(p => prefixes.some(prefix => (p.getAttribute('d') || '').startsWith(prefix)));
const sidebarIcons = ['M9.67272 0.522841', 'M17.2027 4.90034'];
const newChatIcons = ['M8 0.599609', 'M9.99994 1.22943'];
const newChatName = /^(?:(?:开启|新建|创建|开始)(?:新)?(?:对话|聊天)|新(?:对话|聊天)|new (?:chat|conversation)|(?:start|create|open)(?: a)? new (?:chat|conversation))(?:\s*(?:[（(].*[)）]|(?:⌘|Ctrl|Control|Command).*))?$/i;
function newChatLabels(el: HTMLElement) {
  const references = ['aria-labelledby', 'aria-describedby'].map(name => (el.getAttribute(name) || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' '));
  return [...['aria-label', 'title', 'data-tooltip-content', 'data-tooltip', 'data-label'].map(name => el.getAttribute(name)), ...references, el.textContent]
    .filter((value): value is string => !!value).map(value => value.replace(/\s+/g, ' ').trim());
}
function newChatButton() {
  const controls = buttons().filter(el => {
    if (el.closest('[inert], [aria-disabled="true"], .ds-message, [data-message-id], [data-role="message"], #messages') || el.matches(':disabled, [disabled]')) return false;
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || el.querySelector('button, [role="button"], a[href], [tabindex="0"]')) return false;
    const href = el.getAttribute('href');
    if (href !== null) {
      try { if (new URL(href, location.href).origin !== location.origin) return false; } catch { return false; }
    }
    return true;
  });
  return controls.find(el => newChatLabels(el).some(value => newChatName.test(value)))
    || controls.find(el => ['data-testid', 'data-test-id', 'data-action', 'id'].some(name => /^(?:new|create)[-_](?:chat|conversation)(?:[-_]button)?$/i.test(el.getAttribute(name) || '')))
    || controls.find(el => {
      const href = el.getAttribute('href');
      if (!href) return false;
      const target = new URL(href, location.href);
      return target.pathname === '/' && !target.search && !target.hash;
    })
    || controls.find(el => hasIcon(el, newChatIcons));
}
function startNewChat() {
  clearTimeout(newChatTimer);
  if (!composer()) return;
  const previousURL = location.href;
  const fallback = () => {
    if (location.href === previousURL && location.pathname !== '/') location.assign(new URL('/', location.origin).href);
  };
  const button = newChatButton();
  if (button) {
    button.click();
    newChatTimer = setTimeout(fallback, 1000);
  } else fallback();
  setTimeout(focusComposer, 150);
}
function sidebarButton() {
  return buttons().find(el => /^(?:收起侧边栏|展开侧边栏|折叠侧边栏|打开侧边栏|关闭侧边栏|Toggle sidebar|Collapse sidebar|Expand sidebar)/i.test(label(el)))
    || buttons().find(el => /sidebar|侧边栏/i.test(el.getAttribute('aria-label') || el.getAttribute('title') || ''))
    || buttons().find(el => hasIcon(el, sidebarIcons));
}
function isCollapsed() {
  const button = sidebarButton();
  if (button && /展开|打开|Expand|Open/i.test(label(button))) return true;
  const sidebar = document.querySelector('aside, [role="complementary"], [class*="ds-sidebar"]');
  if (sidebar) return !visible(sidebar);
  return !buttons().some(el => hasIcon(el, [sidebarIcons[0]]));
}
function collapseSidebar() {
  if (!quick || !composer() || autoCollapsed) return;
  const button = sidebarButton();
  if (button && !isCollapsed()) { button.click(); autoCollapsed = true; }
}
function focusComposer() {
  focusPending = true;
  queueProbe();
}
function applyComposerFocus() {
  if (!focusPending || document.hidden || !document.hasFocus() || document.querySelector('dialog[open], [aria-modal="true"]')) return;
  const input = composer();
  if (!input) return;
  input.focus({ preventScroll: true });
  focusPending = false;
}
function collapseThinking() {
  // Use the site's own collapse control; never hide or rewrite the response.
  const groups = new Set(document.querySelectorAll<HTMLElement>('.ds-message > [style*="--collapsible-area-title-height"]'));
  document.querySelectorAll('.ds-think-content').forEach(el => { if (el.parentElement) groups.add(el.parentElement); });
  for (const group of groups) {
    if (handledThinking.has(group)) continue;
    const header = group.firstElementChild as HTMLElement | null;
    if (!header || !/^(?:Thinking\b|Thought\s+for\b|(?:已)?(?:深度)?思考)/i.test(label(header))) continue;
    const control = header.matches('button, [role="button"]') ? header : header.firstElementChild as HTMLElement | null;
    if (!control) continue;
    handledThinking.add(group);
    if (Array.from(group.querySelectorAll('.ds-think-content')).some(el => el.getClientRects().length > 0)) control.click();
  }
}
function conversationHeight(messages: HTMLElement[]): number {
  const input = composer();
  if (!input) return 360;
  let inputHeight = input.getBoundingClientRect().height;
  let parent = input.parentElement;
  for (let i = 0; parent && i < 4; i++, parent = parent.parentElement) {
    const height = parent.getBoundingClientRect().height;
    if (height >= 70 && height <= 240) inputHeight = Math.max(inputHeight, height);
  }
  if (!messages.length) return 360 + Math.max(0, inputHeight - 124);
  const rects = messages.map(el => el.getBoundingClientRect());
  const top = Math.min(...rects.map(r => r.top));
  const bottom = Math.max(...rects.map(r => r.bottom));
  // Native titlebar + site navigation + messages + composer and breathing room.
  return 58 + 60 + (bottom - top) + Math.max(100, inputHeight) + 48;
}
function probe(force = false) {
  collapseSidebar();
  collapseThinking();
  if (focusPending) requestAnimationFrame(applyComposerFocus);
  const input = composer();
  const loginInput = Array.from(document.querySelectorAll('input[type="password"], input[autocomplete="tel"], input[autocomplete="username"]')).some(visible);
  const loginPath = /\/(?:sign_in|sign-in|login|auth)(?:\/|\?|$)/i.test(location.pathname);
  const messages = Array.from(document.querySelectorAll<HTMLElement>('.ds-message, [data-message-id], [data-role="message"], #messages > *')).filter(el => el.getClientRects().length > 0);
  const info = { auth: input ? 'chat' : (loginInput || loginPath) ? 'login' : 'unknown', sidebarCollapsed: isCollapsed(), contentHeight: Math.ceil(conversationHeight(messages)), hasMessages: messages.length > 0, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches };
  const serialized = JSON.stringify(info);
  if (force || serialized !== lastProbe) { lastProbe = serialized; ipcRenderer.send('wire:page-state', info); }
}
function queueProbe() { if (!probeTimer) probeTimer = setTimeout(() => { probeTimer = undefined; probe(); }, 120); }

ipcRenderer.on('wire:page-config', (_event, config: { quick: boolean; focus: boolean }) => {
  if (quick !== config.quick) { autoCollapsed = false; }
  quick = config.quick;
  if (document.readyState !== 'loading') probe(true);
  if (config.focus) focusComposer();
});
ipcRenderer.on('wire:page-action', (_event, action: string) => {
  if (action === 'toggle-sidebar') {
    const button = sidebarButton();
    if (button) { autoCollapsed = true; button.click(); setTimeout(probe, 100); }
    else ipcRenderer.send('wire:page-notice', '未找到官网侧边栏按钮，可展开窗口后使用网页中的侧边栏。');
  }
  if (action === 'new-chat') startNewChat();
});

window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('pointerdown', () => { focusPending = false; }, true);
  document.addEventListener('keydown', () => { focusPending = false; }, true);
  window.addEventListener('blur', () => { focusPending = false; });
  window.addEventListener('focus', queueProbe);
  document.addEventListener('compositionstart', () => { composing = true; }, true);
  document.addEventListener('compositionend', () => { composing = false; }, true);
  document.addEventListener('keydown', event => {
    const modifier = navigator.platform.includes('Mac') ? event.metaKey : event.ctrlKey;
    if (!modifier || event.altKey || event.repeat || event.isComposing || composing) return;
    const key = event.key.toLowerCase();
    const command = key === 'n' && !event.shiftKey ? 'new-chat' : key === 'w' && !event.shiftKey ? 'hide' : key === ',' && !event.shiftKey ? 'settings' : key === 'e' && event.shiftKey ? 'toggle-mode' : '';
    if (!command) return;
    event.preventDefault(); event.stopImmediatePropagation();
    ipcRenderer.send('wire:page-command', command);
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.isComposing || composing) return;
    if (document.querySelector('dialog[open], [role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"]')) return;
    // Let the site's own handler consume Escape before treating it as a desktop action.
    setTimeout(() => { if (!event.defaultPrevented) ipcRenderer.send('wire:page-escape'); }, 0);
  });
  new MutationObserver(queueProbe).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'style', 'aria-label', 'aria-expanded'] });
  const resize = new ResizeObserver(queueProbe);
  resize.observe(document.body);
  window.addEventListener('resize', queueProbe);
  document.addEventListener('load', queueProbe, true);
  window.addEventListener('popstate', queueProbe);
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => probe(true));
  probe();
});
