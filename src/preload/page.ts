import { ipcRenderer } from 'electron';

// This isolated preload exposes no bridge or Node capabilities to the official site.
let quick = false;
let composing = false;
let autoCollapsed = false;
let lastProbe = '';
let probeTimer: ReturnType<typeof setTimeout> | undefined;
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
  const input = composer();
  if (input) input.focus({ preventScroll: true });
}
function conversationHeight(): number {
  const input = composer();
  if (!input) return 360;
  let inputHeight = input.getBoundingClientRect().height;
  let parent = input.parentElement;
  for (let i = 0; parent && i < 4; i++, parent = parent.parentElement) {
    const height = parent.getBoundingClientRect().height;
    if (height >= 70 && height <= 240) inputHeight = Math.max(inputHeight, height);
  }
  const messages = Array.from(document.querySelectorAll<HTMLElement>('.ds-message, [data-message-id], [data-role="message"], #messages > *')).filter(el => el.getClientRects().length > 0);
  if (!messages.length) return 360 + Math.max(0, inputHeight - 124);
  const rects = messages.map(el => el.getBoundingClientRect());
  const top = Math.min(...rects.map(r => r.top));
  const bottom = Math.max(...rects.map(r => r.bottom));
  // Native titlebar + site navigation + messages + composer and breathing room.
  return 58 + 60 + (bottom - top) + Math.max(100, inputHeight) + 48;
}
function probe(force = false) {
  collapseSidebar();
  const input = composer();
  const loginInput = Array.from(document.querySelectorAll('input[type="password"], input[autocomplete="tel"], input[autocomplete="username"]')).some(visible);
  const loginPath = /\/(?:sign_in|sign-in|login|auth)(?:\/|\?|$)/i.test(location.pathname);
  const info = { auth: input ? 'chat' : (loginInput || loginPath) ? 'login' : 'unknown', sidebarCollapsed: isCollapsed(), contentHeight: Math.ceil(conversationHeight()) };
  const serialized = JSON.stringify(info);
  if (force || serialized !== lastProbe) { lastProbe = serialized; ipcRenderer.send('wire:page-state', info); }
}
function queueProbe() { if (!probeTimer) probeTimer = setTimeout(() => { probeTimer = undefined; probe(); }, 120); }

ipcRenderer.on('wire:page-config', (_event, config: { quick: boolean; focus: boolean }) => {
  if (quick !== config.quick) { autoCollapsed = false; }
  quick = config.quick;
  if (document.readyState !== 'loading') { probe(true); if (config.focus) focusComposer(); }
});
ipcRenderer.on('wire:page-action', (_event, action: string) => {
  if (action === 'toggle-sidebar') {
    const button = sidebarButton();
    if (button) { autoCollapsed = true; button.click(); setTimeout(probe, 100); }
    else ipcRenderer.send('wire:page-notice', '未找到官网侧边栏按钮，可展开窗口后使用网页中的侧边栏。');
  }
  if (action === 'new-chat') {
    const button = buttons().find(el => /^(?:开启新对话|新建对话|新对话|New chat|Start new chat)(?:\s|$)/i.test(label(el)))
      || buttons().find(el => hasIcon(el, newChatIcons));
    if (button) { button.click(); setTimeout(focusComposer, 150); }
    else ipcRenderer.send('wire:page-notice', '未找到官网新对话按钮，请使用网页中的新对话入口。');
  }
});

window.addEventListener('DOMContentLoaded', () => {
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
  probe();
});
