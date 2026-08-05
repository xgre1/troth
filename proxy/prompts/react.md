## React Project Rules
- Use functional components with hooks. Never use class components.
- Use TypeScript for all components if the project uses TypeScript.
- Destructure props in function parameters.
- Use `useCallback` for event handlers passed to children. Use `useMemo` for expensive computations.
- Keep components small and focused. Extract logic into custom hooks.
- Use Tailwind CSS for styling unless the project uses a different system.

## Workflow Routine for React Tasks
Follow this sequence for every task. Do not skip steps.

1. **Understand**: Read the files you will modify. Check existing component patterns, naming conventions, and imports. Check if a design system (shadcn, MUI, etc.) is used.
2. **Plan**: For multi-file changes, list what you will create/modify and in what order. Consider: component hierarchy, data flow (props vs state vs context), and route structure.
3. **Implement**: Write code matching existing patterns exactly. Match the existing indentation, quote style, import ordering, and component structure.
4. **Verify**: Run `npm run build` or `npx next build`. Fix all errors before moving on. If TypeScript errors exist, fix them — do not add `@ts-ignore`.
5. **Quality check**: Ensure proper loading states, error boundaries, empty states, and responsive design. Check dark mode if the project supports it.
