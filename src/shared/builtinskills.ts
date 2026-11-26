/**
 * The skills Wumpy ships with.
 *
 * Each is the text of a SKILL.md, in Claude's layout - a header saying what
 * it is and when it is for, then instructions written to the model - and is
 * copied into the skills folder the first time Wumpy finds it missing
 * (main/skills.ts), so it is a file like any other: read it, change it,
 * delete it. A changed one is left alone; one still as shipped is brought up
 * to date when Wumpy's own copy changes; a deleted one stays deleted.
 *
 * Asked for as "skills like grill, explain this to a 5-year-old, humanized
 * text", and then "a few others that Claude also might have, closely
 * following their structure".
 *
 * Written the way a good skill is written: what it is for in the
 * description (that is what decides when it is used), then the method as
 * steps, then the rules that stop the predictable failure, then the shape of
 * the answer. No skill is longer than a page.
 */

export const BUILTIN_SKILLS: Record<string, string> = {
  grill: `---
name: grill
description: Grill me on a plan, idea or decision - relentless questions, one at a time, until every branch is settled. Use when they want a plan stress-tested before they commit to it.
triggers: grill me, grill my, stress test my plan, poke holes in
argument-hint: <plan, idea or decision>
---
# Grill

Interview me about this until we both understand it completely: $ARGUMENTS

## How

1. Restate the plan in two sentences, so I can correct a misreading before it costs anything.
2. Walk the decision tree. Every plan rests on choices; take them one at a time, and settle the ones others depend on first.
3. Ask ONE question per message. Put your own recommended answer beside it, with a line on why - I can just say "yes" when you are right.
4. Push on the weak spots: the assumption nothing checks, the cost nobody counted, the case where it fails, the thing that happens if it works too well, the person who has to say yes.
5. If a question can be answered by looking (a file, a page, a number), say what to look at instead of asking me to guess.
6. When an answer opens a new branch, follow it before moving on. When a branch is settled, say so in a line.

## Rules

- Do not be agreeable for its own sake. "Sounds great" is not a question.
- Do not ask several questions in one message, and do not ask what you could work out.
- Keep each message short: the question, your recommendation, why.
- If I say "enough" or "wrap up", stop asking.

## Finish

When nothing is left open, give:

**Settled** - each decision, one line each.
**Risks** - what could still go wrong, most serious first.
**Next** - the first three concrete steps.
`,

  eli5: `---
name: eli5
description: Explain something as if to a five-year-old - plain words, one everyday comparison, no jargon. Use when they ask for something explained simply, or "like I'm five".
triggers: eli5, explain like i'm five, explain like im five, explain it like i'm 5, like i'm five, like im 5
argument-hint: <topic or question>
---
# Explain like I'm five

Explain this so a curious five-year-old would get it: $ARGUMENTS

## How

1. Find the one idea that matters. A five-year-old needs one idea, not a survey.
2. Pick one comparison from their world - toys, snacks, bath time, the playground, a family car - and carry it through the whole explanation instead of switching between several.
3. Say it in short sentences, with words a child uses. If a real term matters, say it once and explain it straight away ("it's called gravity - that's the pull that makes things fall").
4. End with the "so that's why..." line that ties the comparison back to the real thing.

## Rules

- No jargon, acronyms, numbers or history unless the answer is nothing without them.
- Simple is not wrong: keep it true. If the comparison breaks somewhere important, say so in one line ("this part is different for real...").
- Four short paragraphs at most. Usually two is enough.
- Warm, never babyish or sarcastic. Do not say "great question".

## Then

Offer one line: "Want the grown-up version?" - and if they say yes, give the same idea properly, for an adult who is new to it.
`,

  humanize: `---
name: humanize
description: Rewrite text so it reads like a person wrote it - cut the tells of AI writing, keep the meaning and the facts. Use when they want text humanized, made to sound natural, or less like a chatbot.
triggers: humanize, humanise, sound more human, sound less like ai, less robotic, sound natural
argument-hint: <text to rewrite>
---
# Humanize

Rewrite this so it reads like a thoughtful person wrote it: $ARGUMENTS

If no text was given, ask for it in one line and wait.

## What to fix

Cut or replace the patterns people now read as machine-written:

- Stock words: delve, tapestry, testament, realm, landscape, navigate, leverage, robust, seamless, elevate, unlock, foster, pivotal, crucial, vibrant, "in today's fast-paced world".
- Throat-clearing and padding: "It's important to note that", "In conclusion", "Overall", "When it comes to", "Let's dive in", "I hope this helps".
- Lists of three by reflex ("fast, simple, and powerful"), and paired opposites ("It's not just X, it's Y").
- Em-dashes used as all-purpose punctuation. Use a full stop, a comma or brackets the way a person would.
- Every sentence the same length and shape. Mix short ones with longer ones.
- Headings and bullets on something that should just be a paragraph.
- Hedging on everything ("may potentially", "can often help"), and praise of the reader.
- Grand openings and tidy moral endings. Start with the point; stop when it is made.

## Keep

- The meaning, every fact, name, number and link, and the order of the argument.
- The writer's own voice and register: a text to a friend stays casual, a cover letter stays formal.
- The language and spelling (British stays British).
- Roughly the length. Shorter is fine when it was padded.

## Answer

Give the rewritten text only, ready to paste - no preamble. Then one line, in italics, naming the two or three biggest changes. Do not invent experiences, opinions or details the original did not have.
`
}
