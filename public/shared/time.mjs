// GENERATED FILE - DO NOT EDIT.
// Copied from shared/time.mjs by scripts/sync-shared.mjs.
// Edit the original and run: npm run sync:shared
// Day boundaries for quota counting and trend "run_date" / "fetched_on".
// Quotas reset at midnight Pacific, but one fixed timezone keeps things
// simple and predictable: everything is counted per IST day.
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

export function istDay(d = new Date(), timeZone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
}

export const hoursSince = (iso) => Math.max((Date.now() - new Date(iso).getTime()) / 3600000, 0.5);
