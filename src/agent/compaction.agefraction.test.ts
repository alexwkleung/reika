import { afterEach, describe, expect, it, vi } from 'vitest';

// AGE_LOW_FRACTION is read once at module load (like every other REIKA_ flag), so each case needs a
// fresh copy of the module.
async function fresh(value?: string) {
  vi.resetModules();
  if (value === undefined) delete process.env.REIKA_AGE_LOW_FRACTION;
  else process.env.REIKA_AGE_LOW_FRACTION = value;
  return import('./compaction.js');
}

afterEach(() => {
  delete process.env.REIKA_AGE_LOW_FRACTION;
});

// #253: how deep each shrink event sheds is the lever on shrink-event *frequency*, and the issue
// deliberately left the value open — deeper means fewer full re-processes but a smaller live working
// set, and only a measured run can say which wins. The flag exists so that A/B is runnable; these
// tests only guarantee it can't be set to a value that breaks the mechanism.
describe('AGE_LOW_FRACTION (REIKA_AGE_LOW_FRACTION)', () => {
  it('defaults to 0.7 when unset', async () => {
    expect((await fresh()).AGE_LOW_FRACTION).toBe(0.7);
  });

  it('takes a value inside the band', async () => {
    expect((await fresh('0.5')).AGE_LOW_FRACTION).toBe(0.5);
  });

  it('rejects a value so high the event sheds nothing and re-fires next round', async () => {
    expect((await fresh('0.99')).AGE_LOW_FRACTION).toBe(0.7);
  });

  it('rejects a value that would throw away most of the live context in one step', async () => {
    expect((await fresh('0.05')).AGE_LOW_FRACTION).toBe(0.7);
  });

  it('falls back to the default on a malformed value rather than disabling aging', async () => {
    // Number('') is 0 and Number('half') is NaN — both must land on the default, not on a fraction
    // of 0 (which would age the entire history on the first shrink event).
    expect((await fresh('half')).AGE_LOW_FRACTION).toBe(0.7);
    expect((await fresh('')).AGE_LOW_FRACTION).toBe(0.7);
  });
});
