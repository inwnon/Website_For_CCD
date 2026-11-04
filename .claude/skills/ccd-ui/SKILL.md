---
name: ccd-ui
description: House design rules for SRU News Hub pages. Use when designing a new page or changing how an existing page looks; not needed for API work, bug fixes, or copy edits.
---

# ccd-ui — design rules for this repo

For a brand-new page with no reference, also load the `frontend-design` skill for overall direction. These rules win where they differ.

## Brand first
- Check `brand_assets/` before designing; use its logo, colors, and images instead of placeholders.
- Colors: brand palette from `tailwind.config.cjs`; never stock Tailwind colors (indigo-500, blue-600…).

## Reference image given
- Match layout, spacing, type, and color exactly. Placeholder content only (placehold.co images in mockups, never in real pages).
- Do not add components or "improve" the reference.

## No reference
- Pair a display/serif face with a clean sans; large headings tracking `-0.03em`; body line-height `1.7` (Thai never below 1.6).
- Shadows: layered, color-tinted, low opacity — not `shadow-md`.
- Spacing from consistent tokens, not random Tailwind values.
- Depth: base → raised → floating surfaces, not one flat plane.
- Images: `bg-gradient-to-t from-black/60` overlay, optional `mix-blend-multiply` tint.

## Speed guard (LCP ≤ 2.5 s on mobile)
- Layered radial gradients and SVG noise: hero/large static areas only, never on long lists, cards in grids, or anything animated or scrolling.
- Prefer one small static noise image over live SVG filters when the area is large.
- Hero image: correct `width`/`height`, `fetchpriority="high"`; everything below the fold `loading="lazy"`.
- No new web fonts or weights without running `npm run build:fonts`.

## Motion and states
- Animate only `transform` and `opacity`, spring-style easing; respect `prefers-reduced-motion`.
- Never `transition-all`.
- Every clickable element has hover, focus-visible, and active states.

## Before handing back
- `npm run build:css` after any class change.
- Screenshot from `http://localhost:3000` (never `file:///`) at 390px and desktop.
- WCAG 2.1 AA (axe clean, full keyboard use), no horizontal scroll at 390px, CLS < 0.1.
