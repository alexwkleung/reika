// Single source of truth for the UI palette. Tweak here to retheme.
// Pattern across the app: accent = brand/focus, secondary = muted, warning = wait,
// error = problem, success = additions.

export const theme = {
  accent: 'magentaBright',
  secondary: 'gray',
  warning: 'yellow',
  error: 'red',
  success: 'green',
} as const;
