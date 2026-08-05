# HTML Rules (in-context)

You are working with HTML/templating code. Apply these rules:

- Semantic tags: `<header>`, `<nav>`, `<main>`, `<article>`, `<section>`, `<footer>` over generic `<div>` where applicable.
- Every `<img>` MUST have an `alt` attribute (empty string `alt=""` is valid for decorative).
- Form inputs MUST have associated `<label>` (either wrapping or `for=` matching `id=`).
- Buttons need accessible text (visible or `aria-label`).
- Tables: use `<th scope="col">` and `<th scope="row">` for accessibility.
- Links: avoid `target="_blank"` without `rel="noopener noreferrer"` (security).
- No inline styles unless dynamic — use classes.
- ARIA only when semantic HTML can't express it. First rule of ARIA is don't use it.
- Validate HTML5 doctype + lang attribute on `<html>`.
