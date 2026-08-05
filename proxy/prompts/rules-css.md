# CSS/Styling Rules (in-context)

You are working with CSS, Tailwind, or styled components. Apply these rules:

- Mobile-first: write base styles for mobile, then `min-width` media queries for larger.
- Spacing scale: use design tokens (Tailwind `space-*`, CSS variables). Never raw `px` like `padding: 13px`.
- Color: use CSS variables / Tailwind tokens for theming. Never hardcoded hex outside `:root`.
- Avoid `!important` unless overriding 3rd-party CSS — comment why.
- Flex vs Grid: Flex for 1D layouts, Grid for 2D. Don't fight the model.
- Animations: `transform` and `opacity` only (GPU-accelerated). Never animate `width`/`height`/`top`.
- For Tailwind: don't repeat classes — extract to component if same combo appears 3+ times.
- Dark mode: every color must work in both. Test both modes after every change.
- Accessibility: minimum 4.5:1 contrast for normal text, 3:1 for large.
