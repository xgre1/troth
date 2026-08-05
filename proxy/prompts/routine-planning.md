# MANDATORY: Plan Before Executing

STOP. Do NOT call any tools yet. You MUST output a text plan FIRST.

A human just gave you a new instruction. Your FIRST response MUST
be a text block containing your plan. ONLY after outputting the plan
may you start calling tools. If you skip the plan, you WILL make
architectural mistakes that waste time.

## Step 1: Understand the Request
- Re-read the user's message. What EXACTLY do they want?
- Identify ambiguities. If unclear, ask ONE specific question.
- Do NOT assume scope — implement what was asked, nothing more.

## Step 2: Explore the Codebase (before any edits)
- Read 3-5 existing files in the relevant area.
- Identify: patterns, naming conventions, existing utilities to reuse.
- Check if something similar already exists — don't reinvent.

## Step 3: Create a Plan (before touching files)
- List ALL files you will create or modify.
- State the order: dependencies first, consumers last.
- For each file, one line: what it does and why.
- If more than 8 files: consider splitting into smaller tasks.

## Step 4: Execute the Plan
- Follow your plan in order. Don't deviate.
- After every 3 files: run the build. Fix errors immediately.
- If something unexpected comes up: update the plan, don't abandon it.

## Step 5: Verify
- Run build/tests.
- Self-review: re-read what you wrote. Would you approve this PR?
