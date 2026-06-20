// Single source of truth for the UI palette. Tweak here to retheme.
// Pattern across the app: accent = brand/focus, secondary = muted, warning = wait,
// error = problem, success = additions.

export const theme = {
  accent: '#d68cd6', // soft orchid magenta — pastel but luminous enough to read as focus/selection
  inlineCode: '#d7a8d7', // soft magenta echoing the accent, readable in prose
  tool: '#c8c8c8',
  info: 'cyan',
  secondary: '#a0a0a0',
  muted: '#808080',
  reasoning: '#6495ed', // cornflower blue: thinking-block bar, dimmer than the accent
  warning: 'yellow',
  error: 'red',
  success: 'green',
  userBg: '#303030',
  // Status-line mode tags. The two heavily-used modes get soft accents so they
  // read at a glance (without clashing with the yellow warning); the secondary
  // modes sit back in grey.
  modeAgent: '#d7a8d7', // soft magenta, echoes inlineCode — the default workhorse
  modePlan: '#8fd0c8', // soft teal-cyan
  modeChat: '#a0a0a0', // slightly lighter than muted — secondary, recedes
  modeShell: '#9fd49f', // soft green, tied to the $ prompt
} as const;
