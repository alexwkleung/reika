---
title: Why the web search has a human in it
date: 2026-11-08
kind: engineering
summary: SearXNG got CAPTCHA'd without saying so, so Reika drives a real Chrome and asks a person to clear the occasional bot check.
---

# Why the web search has a human in it

Reika's web search sometimes asks you to solve a CAPTCHA manually when the upstream engine shows a bot check. That behavior is intended and not a bug.

## The problem

I wanted to add web search to my coding agent that was reliable and worked well without paid APIs. For that, the default choice for local and privacy focused users is SearXNG, which is a metasearch engine that queries a bunch of upstream engines. I myself have used SearXNG for a while and thought it would've been a good choice to add to Reika and so that's what I went with.

During testing it worked fine. But then I started to get worse results over time and sometimes unrelated ones that didn't match the query.

The problem that made the issue worse was how the agent got fed those results.

SearXNG sends requests as a bare HTTP client and upstream engines have detectors that spit out CAPTCHAs for automated traffic in short bursts. When CAPTCHAs or blocks occur, SearXNG does not treat it as a failure and just sends whatever it extracted. Often, it'll just be nothing or just results that are gibberish.

When an agent gets fed those results, it takes that literally verbatim and can decide that the query it did was bad. So then it rewords it and searches again, and then gets stuck in the refusal or useless loop. The first fix attempted ([#236](https://github.com/alexwkleung/reika/pull/236)) was just making a blocked search say it was blocked. The fix stopped the spiral, but the search was still unusable.

## What I tried first

All of the below methods have some cost to them, so there's no free lunch. But each attempted method can solve it in one way but it's not perfect.

- Paid proxies or CAPTCHA solving services. The cost can vary between providers but when you're on a budget, you'll find yourself using sketchy providers more often than not. I really didn't like sending my requests through a middleman just to avoid CAPTCHAs and that made the privacy aspect of SearXNG kind of useless.
- Accepting degraded results. The quality hit and inconsistent output even when at times it works, wasn't the most sustainable. And seeing the behavior of the model struggle when it occurred was actually painful to watch.
- Automated headless browser like Playwright. While this could work in theory, I found that you'd just run into the same CAPTCHA and blocking problem. Even when using stealth plugins or implementations, it's just inconsistent. And it's just a heavy dependency for a lightweight-ish CLI.
- Human for occasional checks. It's manual grunt work, but when it's rare, it's just a one time annoyance.

## What shipped

Reika now drives a real Chrome over the DevTools protocol ([#235](https://github.com/alexwkleung/reika/issues/235)), with a persistent profile, and uses [Defuddle](https://github.com/kepano/defuddle) to pull the readable text out of pages. The protocol client has no dependencies, because Node ships a WebSocket, so it needs nothing at runtime except Chrome. There's no server, no API key and no proxy.

A few decisions did most of the work:

- Brave, not Google or Bing. On live results pages Google kept 0 of 53 links as usable URLs and Bing 0 of 46, because both route every link through a tracker. Brave returns real links and runs its own index. Other lenient engines like DuckDuckGo could've been a candidate as well but Brave worked a little better.
- A persistent profile being the anti-bot mechanism. A fresh profile has no history, so it looks like a bot. But with a profile that has been used and maybe clears CAPTCHAs occasionally still works majority of the time. Once a CAPTCHA is solved, I was able to continue on without much friction.
- The browser isn't headless. It launches minimized in the background so it doesn't focus during work or pollute your main browser instance. So it's separated in that sense.
- The CAPTCHA is a thing that a person needs to deal with and not an automated retry ([#238](https://github.com/alexwkleung/reika/issues/238)). The CAPTCHA doesn't clear on its own so retrying burns requests and spams the upstream engines redundantly. So when a CAPTCHA appears, Reika raises the browser window, waits a maximum of two minutes for it to be solved, then continues on with the search. If it isn't solved then the search fails and the tool properly errors instead of forcing an empty/useless search.

The measured details are written up in [Building on Reika](../building-on-reika.md#search-brave-not-google-or-bing-when-driving-a-browser).

## What it cost

There is a tradeoff when you need manual CAPTCHA solving. It assumes someone is around to solve it. An unattended run that gets blocked by a CAPTCHA gets stuck for around two minutes and errors out on the search.

For this, I don't think it makes the manual approach worse than the unattended version. Mostly just a choice. Chrome CDP is something you can automate, so if you need unattended runs to work, then you can modify the core of it with a solver implementation. But unattended web search does have a bit of downsides too.

- The persistent profile is an identity. It's Reika's own profile, separate from your everyday Chrome, but it builds up cookies and history over time and searches from your IP. SearXNG strips cookies before querying but this doesn't.
- Every page the agent reads can carry a prompt injection, read by a model that may not be sandboxed. (Reika's guard against data leaking out through URLs is [#548](https://github.com/alexwkleung/reika/issues/548).)

So for my own workflow and what I found to be the most practical, having manual CAPTCHA solving is the thing that works well, and how I use Reika myself. The CAPTCHAs mostly come up when an agent spams a ton of searches too quick without resting periods. I found approximately 15 consecutive searches is what triggers on Brave at least. Reika allows 3 searches per turn by default (`REIKA_MAX_SEARCHES_PER_TURN`), so a burst like that is less likely to occur within one turn.
As for Reika, it's on by default on macOS when Chrome is found on the system. Other operating systems it's opt-in via `REIKA_CDP_SEARCH=1`, because launching the browser will usually take focus and there isn't a clean way like macOS has.
