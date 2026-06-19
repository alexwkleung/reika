// Single source of truth for the UI palette. Tweak here to retheme.
// Pattern across the app: accent = brand/focus, secondary = muted, warning = wait,
// error = problem, success = additions.

export const theme = {
  accent: 'magentaBright',
  inlineCode: '#d7a8d7', // soft magenta echoing the accent, readable in prose
  tool: '#c8c8c8',
  info: 'cyan',
  secondary: '#a0a0a0',
  muted: '#808080',
  warning: 'yellow',
  error: 'red',
  success: 'green',
  userBg: '#303030',
} as const;
