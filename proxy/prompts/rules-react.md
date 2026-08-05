# React/Frontend Rules (in-context)

You are working with React/JSX/TSX code. Apply these rules:

- Components must handle 4 states: loading, error, empty, success. Don't ship a component without all 4.
- Use `useState` for component state, NOT for derived values (use `useMemo` instead).
- Wrap event handlers passed to children in `useCallback` only when the child is `React.memo`'d (otherwise wasteful).
- Never call hooks conditionally. Top-level only.
- For lists: always use a stable, unique `key` prop (NOT array index unless truly static).
- Server vs Client components (Next.js App Router): default is Server. Add `'use client'` only when needed (state, effects, browser APIs).
- Avoid prop drilling > 2 levels — use Context, Zustand, or component composition.
- Don't put async logic in `useEffect` directly — wrap in an inner async function or use a library (TanStack Query).
- Accessibility: every `<button>` needs accessible text, every form input needs a label.
