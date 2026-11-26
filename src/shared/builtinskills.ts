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
 * following their structure". The second set takes Claude's own as its
 * models: skill-creator (making skills), brainstorming, systematic
 * debugging, doc co-authoring and internal comms, and the everyday ones -
 * tldr, proofread, decide, tutor.
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
triggers: humanize, humanise, sound more human, sound less like ai, less robotic
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
`,
  'skill-creator': `---
name: skill-creator
description: Make a new Wumpy skill, or improve one - interview me about what it should do, then write it. Use when they want to create, write or change a skill.
triggers: make a skill, create a skill, new skill, write a skill
argument-hint: <what the skill should do>
---
# Skill creator

Help me make a skill for this: $ARGUMENTS

A skill is a SKILL.md: a header, then instructions written to an assistant like you. It runs as /name, and comes in by itself when one of its trigger words is said.

## How

1. Work out what it is for. If something important is missing - what it works on, what a good result looks like, what usually goes wrong - ask, at most three short questions, one at a time. If it is clear enough, skip straight to writing.
2. Choose a short name: lowercase words joined by hyphens, easy to type after a slash.
3. Write the description as two things in one line: what it does, then "Use when ..." with the situations and phrasings that should bring it in. The description is what decides when it is used, so make it specific.
4. Pick two to five triggers: phrases a person actually says, not single common words that would fire by accident.
5. Write the instructions:
   - a title, and one line saying what to do with $ARGUMENTS;
   - "## How": the method, as numbered steps;
   - "## Rules": the few things that stop the predictable failure;
   - the shape of the answer: headings, length, what comes first.
   Keep it under a page. Say what to do, not what to avoid, wherever you can. Explain why a rule exists when the reason is not obvious.
6. Show it to me in a sentence or two, then save it.

## Saving

Put it in your reply exactly like this, and Wumpy saves it as a file and makes it a command:

<skill name="the-name" description="What it does. Use when ..." triggers="phrase one, phrase two" argument-hint="<what it works on>">
the instructions
</skill>

The same name replaces a skill. To improve an existing one, read what it says now, change only what needs changing, and save it under the same name.

## Then

Suggest one way to try it: the exact command to type, with a real example.
`,

  brainstorm: `---
name: brainstorm
description: Turn a rough idea into a clear design through questions and options before anything is built. Use when they have an idea, a feature or a project to shape and have not decided how yet.
triggers: brainstorm, bounce ideas, shape this idea
argument-hint: <idea>
---
# Brainstorm

Help me shape this idea into a design: $ARGUMENTS

## How

1. Understand it first. Ask questions one at a time - prefer multiple choice, so I can answer in a word - about the purpose, who it is for, the constraints, and what success looks like.
2. When the goal is clear, offer two or three genuinely different approaches. For each: how it works, what it is good at, what it costs. Say which you would pick and why.
3. Once I pick, lay out the design in short sections - what it does, the parts, how they fit, what can go wrong, how we will know it works - and check with me after each section before going on.
4. Cut anything that is not needed yet. A smaller first version that works beats a big plan.

## Rules

- One question per message. Do not dump a questionnaire.
- Stay out of the details until the shape is agreed.
- Disagree when an idea has a real problem; say what the problem is.
- Do not start building or writing the final thing. This is for deciding.

## Finish

A short summary: the goal, the chosen approach, the parts, the open questions, and the first step.
`,

  debug: `---
name: debug
description: Find the real cause of a bug or failure before fixing anything - reproduce, read the evidence, test one hypothesis at a time. Use when there is an error, a crash, a failing test or "it doesn't work".
triggers: debug this, help me debug, find the root cause
argument-hint: <error, symptom or failing thing>
---
# Debug

Find out why this is happening, then fix it: $ARGUMENTS

No fix before the cause is known. A guessed fix that seems to work hides the real bug.

## How

1. Read the evidence properly: the whole error, the stack trace, the line numbers, what changed recently. Quote the line that matters.
2. Reproduce it. Work out the smallest steps that make it happen every time. If it cannot be reproduced, say what to log or capture to catch it next time.
3. Narrow it down. Find where good turns into bad: compare a working case with the broken one, and check each step's input and output.
4. Form ONE hypothesis - "X happens because Y" - and the quickest test that would prove it wrong. Run the test (or tell me exactly what to run) before changing anything else.
5. If it is wrong, say so and form the next one. After three wrong guesses, stop and question the assumption underneath them.
6. When the cause is proven, make the smallest fix that addresses it, and say how to confirm it is fixed and nothing else broke.

## Rules

- Change one thing at a time.
- Do not add workarounds, retries or try/catch that hide the symptom.
- Say what you know, what you suspect and what you have not checked - separately.

## Answer

**Cause** - one sentence. **Evidence** - what proves it. **Fix** - the change. **Check** - how to confirm it.
`,

  coauthor: `---
name: coauthor
description: Write a document together, section by section - gather the context, draft, refine, then test it the way a reader would. Use when they want to write a proposal, spec, report, essay or other document with help.
triggers: co-write, coauthor, write a document with me
argument-hint: <what the document is>
---
# Co-author

Help me write this document: $ARGUMENTS

## How

1. **Context.** Ask what it is for, who will read it, what they already know, what they should think or do after reading, and any material to draw on. One or two questions at a time. Ask me to paste or dump everything I have - messy is fine.
2. **Outline.** Propose the sections, each with one line on what it says. Agree it before writing.
3. **Draft, section by section.** For each section: list what could go in it, ask me which points matter, then write it. Ask what to change, and change only that. Move on when I am happy.
4. **Tighten.** When it is all there, read it as a whole: cut repetition, make sure the opening says the point, check every claim is supported.
5. **Reader test.** Read it as the reader would, with none of our conversation in mind. List the questions they would still have and anything they could misread, and fix those.

## Rules

- My words and my facts. Do not invent figures, quotes or claims; mark anything that needs checking with [check].
- Plain language, short paragraphs, the point first.
- Show only the section being worked on, not the whole document each time, until the end.

## Finish

The whole document, ready to paste, then a list of anything still marked [check].
`,

  comms: `---
name: comms
description: Write a status update, announcement, newsletter item or other message to a team - clear, short, the news first. Use when they need to update people at work or school about progress, problems, plans or changes.
triggers: status update, weekly update, progress update
argument-hint: <what happened, and who it is for>
---
# Comms

Write a message to a team from this: $ARGUMENTS

If who it is for or what kind of message it is is unclear, ask in one line. Otherwise write it.

## Pick the shape

- **Status update** (to a manager or team): **Progress** - what got done; **Plans** - what is next; **Problems** - what is blocked and what help is needed. Two or three bullets each.
- **Announcement**: what is changing, when, what it means for the reader, what they need to do, who to ask.
- **Incident or problem**: what happened, who is affected, what is being done, when the next update comes.
- **Newsletter item**: a headline, then three or four sentences on why it matters to the reader.

## Rules

- The most important thing first. Someone who reads only the first line should get the news.
- Concrete: numbers, dates, names, links. "Shipped the login page on Tuesday", not "made good progress".
- Short. Cut anything the reader does not need to act or understand.
- Honest about problems; no spin. Say what help is needed and from whom.
- The register of the audience: a team chat is casual, an all-company email is not.

## Answer

The message, ready to paste - with a subject line if it is an email. Nothing before it.
`,

  tldr: `---
name: tldr
description: Boil something down to what matters - the point in one line, then the few details worth keeping. Use when they want a summary, the gist, or a too-long-didn't-read of a text, page, thread or file.
triggers: tldr, tl;dr, give me the gist, sum this up, summarise this, summarize this
argument-hint: <text, link or thing to summarise>
---
# TL;DR

Summarise this: $ARGUMENTS

## How

1. Find the one thing the author wants the reader to take away.
2. Find the details that change what someone would do: decisions, numbers, dates, deadlines, names, asks, risks.
3. Drop everything else - background, repetition, examples, politeness.

## Answer

**TL;DR:** one sentence.

Then up to five bullets of the details worth keeping, the most important first. Add **Action for you:** only if the text asks the reader to do something.

## Rules

- Use the text's own facts and numbers exactly. Never add anything it did not say.
- If something important is unclear or contradicts itself, say so in one bullet.
- If the text is already short, say the TL;DR and stop.
`,

  proofread: `---
name: proofread
description: Fix spelling, grammar and punctuation with the smallest changes, keeping the writer's voice - then list what changed. Use when they want text checked, corrected or proofread before sending.
triggers: proofread, check my spelling, check my grammar, fix my grammar, any typos
argument-hint: <text to check>
---
# Proofread

Proofread this: $ARGUMENTS

If no text was given, ask for it in one line.

## How

1. Fix what is wrong: spelling, grammar, punctuation, wrong words (their/there, affect/effect), missing words, inconsistent names or capitals.
2. Fix what is clearly unclear: a sentence that can be read two ways, or one so long it loses the reader.
3. Leave everything else alone. The writer's word choices, tone, style and slang are theirs.

## Rules

- Smallest change that fixes it. Do not rewrite for taste.
- Keep the language and spelling variety (British stays British, American stays American).
- Keep the formatting, line breaks and links exactly.
- If nothing is wrong, say "No errors found." and stop.

## Answer

The corrected text, ready to paste. Then **Changes:** a short list - "recieve -> receive", "added comma after 'However'" - grouped if there are many of one kind. Note separately anything you were unsure about.
`,

  decide: `---
name: decide
description: Help make a decision - lay out the options, weigh what matters, and recommend one with the reasons. Use when they are choosing between options, stuck on a choice, or asking "should I...".
triggers: help me decide, pros and cons, decision matrix
argument-hint: <the decision and the options>
---
# Decide

Help me decide this: $ARGUMENTS

## How

1. Restate the decision in one line, and the options. If an obvious option is missing (including "do nothing" or "wait"), add it.
2. Ask what matters most to me if you cannot tell - at most two quick questions. Otherwise work from what I said.
3. Pick the three to five criteria that actually decide it (cost, time, risk, how reversible it is, what I care about) and say how much each weighs.
4. Compare the options against them in a small table, with a word or two per cell - not essays.
5. Check the key facts: anything the decision turns on that is a guess should be named as one.

## Answer

The table, then **Recommendation:** one option, with the two or three reasons that decide it. **What would change my mind:** the one fact that would flip it. **Next step:** something small to do today.

## Rules

- Do commit to a recommendation. "It depends" is not an answer - say what it depends on and pick.
- If it is easily reversible, say so: then the cost of choosing wrong is small, and speed matters more.
- It is my decision. Make the case; do not lecture.
`,

  tutor: `---
name: tutor
description: Teach by asking, not telling - guide me to work it out myself with questions and hints. Use when they want to learn or understand something, practise, or get help with homework without being handed the answer.
triggers: tutor me, quiz me, teach me step by step, socratic
argument-hint: <topic or problem>
---
# Tutor

Help me learn this by working it out myself: $ARGUMENTS

## How

1. Find out where I am: ask what I already know, or have me try the first step. One question.
2. Teach in small steps. Each message: a short explanation or hint if I need one, then ONE question for me to answer.
3. When I answer, say whether it is right first. If it is wrong, find the misunderstanding behind it and give a hint aimed at that - not the answer.
4. If I am stuck after two hints, show that one step worked out, then give me a similar one to do myself.
5. Every few steps, ask me to say the idea back in my own words.

## Rules

- Never give the final answer to homework or a problem straight away. If I insist, give it, but explain each step.
- Keep each message short - a few lines, then the question.
- Use examples from everyday life when an idea is abstract.
- Be encouraging and honest: praise what is right specifically, correct what is wrong plainly.

## Finish

When I have it, give a three-line recap of what I learned and one practice question to try on my own.
`
}
