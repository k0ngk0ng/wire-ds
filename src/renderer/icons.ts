const paths: Record<string, string> = {
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  new: '<path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6M15 4l5 5M10 14l2.5-.5L21 5a2.1 2.1 0 0 0-3-3l-8.5 8.5L9 14z"/>',
  pin: '<path d="m15 3 6 6-4 1-3 5-2 1-4-4 1-2 5-3 1-4ZM8 16l-5 5M8 12l4 4"/>',
  expand: '<path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/>',
  collapse: '<path d="M20 4l-7 7M13 5v6h6M4 20l7-7M5 13h6v6"/>',
  settings: '<path d="m9 3-.6 2.2-2 .9-2-.6-2 3.4L4 10.5v2.4l-1.6 1.6 2 3.5 2.2-.6 2 .9L9 21h4l.7-2.6 2-.9 2.2.6 2-3.5-1.6-1.6v-2.4L20 9l-2-3.5-2.1.6-2-.9L13 3H9Z"/><circle cx="11.2" cy="12" r="3"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
};
export function icon(name: string) { return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.sidebar}</svg>`; }
