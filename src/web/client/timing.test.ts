import { describe, expect, it } from 'vitest';
import { connectionNotice } from './connection.js';
import { BOTTOM_SLACK_PX, isAtBottom, nextFollow } from './follow.js';
import { frameBatched } from './framebatch.js';
import {
  PENDING_ROW_DELAY_MS,
  pendingElapsedMs,
  pendingRowDue,
  serverTime,
} from './pendingdelay.js';

describe('follow', () => {
  const at = (scrollTop: number) => ({ scrollTop, scrollHeight: 2000, clientHeight: 500 });

  it('counts the bottom within the slack', () => {
    expect(isAtBottom(at(1500))).toBe(true);
    expect(isAtBottom(at(1500 - BOTTOM_SLACK_PX))).toBe(true);
    expect(isAtBottom(at(1500 - BOTTOM_SLACK_PX - 1))).toBe(false);
  });

  it('a scroll up stops following, new content keeps the answer, jump restores it', () => {
    let following = true;
    following = nextFollow(following, { type: 'user-scroll', metrics: at(800) });
    expect(following).toBe(false);
    following = nextFollow(following, { type: 'content-grew' });
    expect(following).toBe(false);
    following = nextFollow(following, { type: 'jump' });
    expect(following).toBe(true);
    expect(nextFollow(true, { type: 'content-grew' })).toBe(true);
    expect(nextFollow(false, { type: 'user-scroll', metrics: at(1500) })).toBe(true);
  });

  it('any move up lets go, even inside the slack; a wheel turned up lets go before it lands', () => {
    const inSlack = 1500 - 10;
    expect(nextFollow(true, { type: 'user-scroll', metrics: at(inSlack), previousTop: 1500 })).toBe(
      false,
    );
    // Down inside the slack still follows, so coming back to the bottom picks it up again.
    expect(
      nextFollow(false, { type: 'user-scroll', metrics: at(inSlack), previousTop: 1400 }),
    ).toBe(true);
    expect(nextFollow(true, { type: 'scroll-up-intent' })).toBe(false);
    // Let go, a scroll that did not move down does not take it back however near the bottom.
    expect(
      nextFollow(false, { type: 'user-scroll', metrics: at(inSlack), previousTop: inSlack }),
    ).toBe(false);
    expect(nextFollow(false, { type: 'user-scroll', metrics: at(1500), previousTop: 1500 })).toBe(
      true,
    );
  });

  it('content shrinking under the view moves it up but keeps following', () => {
    const shrunk = { scrollTop: 1200, scrollHeight: 1700, clientHeight: 500 };
    expect(nextFollow(true, { type: 'user-scroll', metrics: shrunk, previousTop: 1500 })).toBe(
      true,
    );
  });
});

describe('pending row delay', () => {
  it('holds a call back for the delay from its server start time', () => {
    expect(pendingRowDue(1000, 1000)).toBe(false);
    expect(pendingRowDue(1000, 1000 + PENDING_ROW_DELAY_MS - 1)).toBe(false);
    expect(pendingRowDue(1000, 1000 + PENDING_ROW_DELAY_MS)).toBe(true);
    expect(pendingElapsedMs(1000, 7000)).toBe(6000);
  });

  it('reads the server time off the tab clock and the measured offset', () => {
    // The server runs 30s ahead; a call it started 6s ago is 6s old here too.
    const offset = 30_000;
    const since = 100_000 + offset - 6000;
    expect(pendingElapsedMs(since, serverTime(100_000, offset))).toBe(6000);
    expect(serverTime(5, null)).toBe(5);
  });

  it('streamed output forces the row up', () => {
    expect(pendingRowDue(0, 10, true)).toBe(true);
    expect(pendingRowDue(0, 10)).toBe(false);
  });
});

describe('frameBatched', () => {
  it('notifies once per frame however many changes land in it', () => {
    const frames: (() => void)[] = [];
    let calls = 0;
    const notify = frameBatched(
      () => calls++,
      cb => void frames.push(cb),
    );
    notify();
    notify();
    notify();
    expect(frames).toHaveLength(1);
    expect(calls).toBe(0);
    frames.shift()!();
    expect(calls).toBe(1);
    notify();
    expect(frames).toHaveLength(1);
  });
});

describe('connectionNotice', () => {
  it('says nothing once open, and names each other state', () => {
    const signedIn = { kind: 'signed-in' as const, token: 't' };
    expect(connectionNotice({ signIn: signedIn, stream: 'open' })).toBeNull();
    expect(connectionNotice({ signIn: signedIn, stream: 'reconnecting' })).toMatch(/reconnecting/);
    expect(connectionNotice({ signIn: signedIn, stream: 'signed-out' })).toMatch(/new one/);
    expect(connectionNotice({ signIn: signedIn, stream: null })).toMatch(/Connecting/);
    expect(connectionNotice({ signIn: { kind: 'link-dead' }, stream: null })).toMatch(
      /already used/,
    );
    expect(connectionNotice({ signIn: { kind: 'no-link' }, stream: null })).toMatch(
      /Not signed in/,
    );
    expect(connectionNotice({ signIn: null, stream: null })).toMatch(/Signing in/);
  });
});
