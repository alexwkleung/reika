---
title: Do small models follow a spill locator?
date: 2026-10-18
kind: research
summary: A capped tool result that points at a saved file. How often a Q2 model reads it, against a baseline that has no file.
---

# Do small models follow a spill locator?

<!-- Template for a research post. Fill the hypothesis in before any runs. -->

**Claim.** One sentence a reader could check.

**Limitations up front.** Model, quantization, machine, number of runs, and what this can't show.

## Hypothesis

Written before the runs, with the result that would count against it.

## Setup

- Commit:
- Model and quant:
- Engine and flags:
- Context window:
- Fixture:
- Arms: `REIKA_X=1` vs the `=0` baseline
- Runs per arm:

## Results

| Arm      | Runs | Outcome | Tool calls | Notes |
| -------- | ---- | ------- | ---------- | ----- |
| baseline |      |         |            |       |
| on       |      |         |            |       |

## What the numbers can't show

## Raw data

Per-run numbers and the `flags` line for each arm, so the result can be re-checked.
