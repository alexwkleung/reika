// A post's date is a calendar day, and `new Date('2026-10-19')` is midnight UTC: formatted in the
// reader's own zone it reads as October 18 anywhere west of Greenwich.
const longDate = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});

export function formatPostDate(isoDay: string): string {
  return longDate.format(new Date(isoDay));
}
