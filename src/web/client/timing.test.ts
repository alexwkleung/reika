import { describe, expect, it } from 'vitest';
import { connectionNotice } from './connection.js';
import { BOTTOM_SLACK_PX, isAtBottom, nextFollow } from './follow.js';
import { frameBatched } from './framebatch.js';
import {
  PENDING_ROW_DELAY_MS,
  pendingElapsedMs,
  pendingRowDue,
  sightCall,
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
});

describe('pending row delay', () => {
  it('holds a call back for the delay from when this tab first saw it', () => {
    let s = sightCall(null, 4, 1000);
    expect(pendingRowDue(s, 4, 1000)).toBe(false);
    expect(pendingRowDue(s, 4, 1000 + PENDING_ROW_DELAY_MS - 1)).toBe(false);
    s = sightCall(s, 4, 1100);
    expect(s?.seenAt).toBe(1000);
    expect(pendingRowDue(s, 4, 1000 + PENDING_ROW_DELAY_MS)).toBe(true);
    expect(pendingElapsedMs(s, 4, 7000)).toBe(6000);
  });

  it('a new call starts its own delay, even under the same name', () => {
    let s = sightCall(null, 4, 1000);
    s = sightCall(s, 5, 5000);
    expect(pendingRowDue(s, 5, 5100)).toBe(false);
    expect(pendingElapsedMs(s, 5, 5100)).toBe(100);
  });

  it('streamed output forces the row up', () => {
    const s = sightCall(null, 1, 0);
    expect(pendingRowDue(s, 1, 10, true)).toBe(true);
    expect(pendingRowDue(null, 1, 10)).toBe(false);
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
