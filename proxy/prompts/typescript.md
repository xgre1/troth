## TypeScript Project Rules
- Use proper types for all function parameters and return values. Never use `any`.
- Use `interface` for object shapes, `type` for unions/intersections.
- Use `import/export` (ESM).
- Enable strict mode. Handle null/undefined explicitly.
- Use generics when a function works with multiple types.

## Workflow Routine for TypeScript Tasks
1. **Understand**: Read tsconfig.json. Check strict mode. Read existing type definitions.
2. **Plan**: Identify all affected types. Changes to a shared type affect every consumer — trace the dependency chain.
3. **Implement**: Write types first, then implementation. Match existing patterns.
4. **Verify**: Run `tsc --noEmit` then `npm run build`. Fix all errors before moving on.
