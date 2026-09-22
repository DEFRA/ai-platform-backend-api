---
layout: default
title: JavaScript Code Review Standards
---

# JavaScript Code Review Standards

This page outlines how a review of JavaScript code should be conducted within the Defra AICE team — what to flag, at what severity, and how to phrase it. It does not say what the code itself should look like; for that, see the [AICE JavaScript Style Guide](../../javascript-style-guide/references/javascript-style-guide.md) and the [AICE JavaScript Testing Standards](../../javascript-testing-standards/references/javascript-testing-standards.md).

This guide applies whenever an AI reviewer — GitHub Copilot Reviews, or an agent using the AICE `review-standards` skill — reviews a JavaScript pull request for a Defra AICE project.

## Table of Contents

- [1 Purpose and Scope](#1-purpose-and-scope)
- [2 Triage Tiers](#2-triage-tiers)
  - [2.1 Blocking](#21-blocking)
  - [2.2 Suggestion](#22-suggestion)
  - [2.3 Question](#23-question)
- [3 What Not to Flag](#3-what-not-to-flag)
- [4 Comment Format](#4-comment-format)
- [5 Test Coverage Review](#5-test-coverage-review)
- [Contributions](#contributions)

## 1 Purpose and Scope

This guide governs *how* a review is conducted, not what the code should look like. When a comment flags a violation of an existing rule, cite the specific section of the [style guide](../../javascript-style-guide/references/javascript-style-guide.md) or [testing standards](../../javascript-testing-standards/references/javascript-testing-standards.md) rather than restating the rule from memory — the guide is the source of truth, not the reviewer's recollection of it.

## 2 Triage Tiers

Every review comment falls into exactly one tier. State the tier at the start of the comment so the author can triage their inbox without opening each thread.

### 2.1 Blocking

A blocking comment identifies something that must be fixed before merge: a correctness bug, a security issue, a missing or inadequate test for new behaviour, or a violation of the style guide or testing standards that automated tooling does not already catch.

Do this:
```
Blocking: `submitOrder` doesn't handle the API rejecting the order — an
unhandled rejection here surfaces as a raw 500 to the user. See the "when
the API rejects" cases in testing-standards §2.2.1 for the shape this
needs; nothing currently covers it.
```

Don't do this:
```
Blocking: this function is a bit long.
```
(Length alone isn't a defined rule anywhere in the style guide — it isn't blocking, and may not be worth a comment at all; see [3 What Not to Flag](#3-what-not-to-flag).)

### 2.2 Suggestion

A suggestion is a non-blocking improvement — readability, naming, a cleaner approach that doesn't change behaviour. Phrase it as an option, not an instruction, and let the author decide.

Do this:
```
Suggestion: `handleClick` and `handleSubmit` duplicate the same three lines
of validation — consider extracting a `validateForm` helper if a third
handler needs it too.
```

Don't do this:
```
You should extract this into a helper.
```
(States a demand for something that isn't blocking — reads as Blocking even though it isn't one.)

### 2.3 Question

A question is genuine uncertainty about intent — something the diff doesn't make clear — not a way to soften an instruction.

Do this:
```
Question: is the 30-second timeout here intentional, or inherited from a
default? The endpoint it calls typically responds in under a second.
```

Don't do this:
```
Question: don't you think this should use async/await instead of .then()?
```
(Not a question — a Suggestion wearing a question mark. State it as one.)

## 3 What Not to Flag

Silence is a valid outcome. Do not comment on:

- Anything `neostandard`/ESLint already enforces or would autofix — see the style guide's [1.1 Linting / Formatting](../../javascript-style-guide/references/javascript-style-guide.md#11-linting--formatting). Duplicating lint output as a review comment adds noise without adding information.
- Pre-existing issues outside the diff. Flagging unrelated code turns a focused review into an unbounded audit and stalls the PR.
- Pure style preference that the style guide doesn't actually specify. "I'd have written it differently" is not a rule.
- Praise with no actionable content ("LGTM", "nice", "looks good"). It isn't wrong, but it isn't a review comment — leave it for the approval, not a thread.

## 4 Comment Format

One comment per distinct issue — never bundle three unrelated points into a single thread, and never split one point across three. Cite the file and line the issue actually lives on, and cite the specific guide section when the issue is a violation of an existing rule, rather than asserting it from memory. A blocking comment proposes a concrete fix or asks for one; it does not stop at naming the problem.

Do this:
```
Blocking (src/pages/checkout/controller.js:42): the cart total is formatted
with `toFixed(2)` before VAT is added — see style-guide §2.4.2 on template
literals for the intended composition. Add VAT first, then format once at
the end.
```

Don't do this:
```
This whole file needs work.
```

## 5 Test Coverage Review

Check new or changed behaviour against the testing standards explicitly, not just for the presence of a test:

- The test asserts something that can fail — no bare `toBeDefined()` or `expect(x).toBeTruthy()` as the only assertion (testing-standards §2.3.1).
- The test lives in the right tree for what it addresses — a mirrored unit test for a module, an integration test for an entry point (testing-standards §1.2).
- Mocking stays within the rules — only owned modules or the network layer, never a third-party type (testing-standards §2.4).

A pull request that changes behaviour with no corresponding test change is a Blocking comment on its own, even if every other rule in this guide is satisfied.

## Contributions

If you would like to contribute to these review standards, please open a pull request on the [Defra AICE Team GitHub](https://github.com/DEFRA/aice-team) repository.

For anything that is not covered by these review standards, we recommend following the [AICE JavaScript Style Guide](../../javascript-style-guide/references/javascript-style-guide.md), the [AICE JavaScript Testing Standards](../../javascript-testing-standards/references/javascript-testing-standards.md), and staying consistent with the existing review history. If alignment across AICE is required, please raise an issue in [Defra AICE Team GitHub](https://github.com/DEFRA/aice-team/issues).
