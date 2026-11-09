# SRU News Hub (ccd2569.cloud): UX/UI and Color Audit

Audit date: 2026-11-06. Site: https://ccd2569.cloud (Thai news hub of Suratthani Rajabhat University).

## How to use this file with Claude Code

Work through the items in priority order. Each item has: evidence (what was measured or seen), the fix, and an acceptance check. Keep changes minimal and scoped to the item. Verify each fix at 618 px, 768 px and 1440 px wide, in both light and dark mode.

Known facts about the codebase (from the rendered pages, not from source access):
- Static-looking pages: `index.html`, `search.html`, `news.html?id=…`, `collection.html`, `contact.html`, `submit.html`, `login.html`, `privacy.html`.
- Tailwind-style utility classes are used (e.g. `text-[14px]`, `inline-flex h-11`).
- Theme is set by a `dark` class on `<html>` (set by JavaScript). Color tokens are CSS variables holding space-separated RGB (e.g. `--bg: 245 244 255`) in `:root` and `.dark`.
- Locate the real files first; do not assume the paths above exist in the repo.

## Scope and method

- Viewport widths: 618 px (phone layout), 768 px (tablet), 1440 px (desktop).
- Pages checked: home, search (including the no-results state), submit, contact, login, and one news detail page.
- Method: DOM scan by script (alt text, labels, tap-target size, font sizes, landmarks), automated contrast check of 188 text nodes (59 more sit on gradients or photos and cannot be measured this way), contrast math on the real CSS tokens, and visual review in both themes.
- Not checked: album page, activity calendar page, the submit form after login (needs a university account), real screen reader testing, full Tab-order walk, whether dark mode flashes light on load, form error state colors.

## Summary

Performance and structure are good: load finished in about 0.5 s, 19 requests, 382 KB, no console errors, `lang="th"`, landmarks present, skip link present, visible focus ring (2.4 px), no horizontal scroll at the three widths tested. There are 23 items to fix: 3 high, 11 medium, 9 low. Color text contrast passes WCAG AA in both themes, but UI borders fail the 3:1 rule and the palette uses too many hues at once.

## Priority table

| # | Issue | Level | Area |
|---|---|---|---|
| 1 | "ติดต่อเรา" nav item clipped on narrow screens | High | UX |
| 2 | Sticky header takes 26% of a phone viewport | High | UX |
| 3 | Contact page has no channel for people outside the university | High | UX |
| 4 | Tablet hero headline breaks badly; header search shrinks | Medium | UX |
| 5 | No news visible above the fold on desktop | Medium | UX |
| 6 | Stray `-----` and lone `.` lines in article body | Medium | UX |
| 7 | Home page has no `og:image` | Medium | UX |
| 8 | Drop cap splits Thai words | Medium | UX |
| 9 | Empty `alt` on news images | Medium | UX |
| 10 | UI border contrast below 3:1 | Medium | Color |
| 11 | Five brand hues at once; red doubles as brand and status | Medium | Color |
| 12 | Small text in light mode barely passes AA (4.7–5.0:1) | Medium | Color |
| 13 | No `theme-color` or `color-scheme` meta | Medium | Color |
| 14 | White text over album cover images depends on the image | Medium | Color |
| 15 | Tap targets under 44 px | Low | UX |
| 16 | View counters show 0 or 1 | Low | UX |
| 17 | Duplicate search box on the search page | Low | UX |
| 18 | Three links use `href="#"` | Low | UX |
| 19 | Text at 11 px | Low | UX |
| 20 | 192 px logo shown at 36–48 px | Low | UX |
| 21 | Google sign-in button style clashes with dark theme | Low | UX |
| 22 | Three images lack lazy loading | Low | UX |
| 23 | Dark-mode text is very bright (17:1) | Low | Color |

---

## High priority

### 1. "ติดต่อเรา" nav item clipped on narrow screens
- Evidence: at 618 px the header nav is 727 px wide but shows 602 px (`overflow-x: auto`). The last item sits at the edge with no fade or arrow. At 768 px and 1440 px all items fit.
- Fix: make the labels fit on one row, or add a right-edge fade mask plus snap scrolling, or move the nav into a menu button below about 700 px.
- Accept: at 375, 414 and 618 px the last nav item is fully visible or the scroll affordance is obvious.

### 2. Sticky header takes too much of a phone screen
- Evidence: header is 177 px tall in a 691 px viewport (26%); the home page is about 11,570 px long. At 1440×900 it is 123 px (14%).
- Fix: keep the logo row sticky; hide the search box and nav row when scrolling down and show them when scrolling up (or collapse into a compact bar).
- Accept: while scrolling down on a phone, the sticky area is under 25% of the viewport height, ideally under 70 px.

### 3. Contact page has no channel for outsiders
- Evidence: only internal extension numbers (e.g. 6902) and a postal address. No `tel:`, `mailto:` or social link in the page HTML. The login page supports "external persons" (any other Google account).
- Fix: add at least one public phone number and an email address, make them `tel:` and `mailto:` links, and link the official Facebook page if one exists. Ask the PR team for the real values; do not invent them.
- Accept: a visitor outside the university can contact the team in one tap.

## Medium priority

### 4. Tablet hero layout
- Evidence: at 768 px the headline wraps as "เรื่องราว / สำคัญ / ใน / มหาวิทยาลัย / ของเรา" because the mascot squeezes the text column; the header search box collapses to the single word "ค้นหา".
- Fix: stack the hero (text above mascot) below about 900 px; give the header search a sensible `min-width`; consider `word-break: keep-all` or explicit phrase breaks for Thai headlines.
- Accept: no one-word lines in the hero headline at 768 px.

### 5. No news above the fold on desktop
- Evidence: at 1440×900 the hero is about 437 px tall followed by three shortcut cards; real news starts after scrolling.
- Fix: shorten the hero and show one or two featured stories in the first screen.
- Accept: at least one news card is visible in the first 900 px of height.

### 6. Stray separators in article text
- Evidence: article body contains `---------------` (twice in the article checked) and a line holding only `.`, apparently copied from Facebook posts.
- Fix: strip runs of 5+ dashes and lone punctuation lines at import or render time; also let editors catch them before publishing.
- Accept: no separator-only or punctuation-only paragraphs in rendered articles.

### 7. Home page lacks `og:image`
- Evidence: news detail pages have a full Open Graph set including `og:image`; the home page has none.
- Fix: add `og:title`, `og:description`, `og:type`, `og:image` (1200×630 recommended) and `twitter:card` to the home page.
- Accept: sharing the home URL in LINE or Facebook shows a preview image.

### 8. Drop cap on Thai text
- Evidence: the first paragraph of an article shows a large pink "ม" followed by small "รส.", which reads like a spelling error.
- Fix: disable the drop cap for Thai (`:lang(th)`), or remove it entirely.
- Accept: the first paragraph renders in uniform size.

### 9. Empty `alt` text on news images
- Evidence: home page 22 of 23 images and article page 14 of 14 images have `alt=""`, including infographics that carry information in the picture.
- Fix: give the lead image, infographics and banners a meaningful `alt` (title or short description). Keep `alt=""` only for purely decorative images such as the mascot or logo duplicates.
- Accept: every image that conveys content has non-empty `alt`.

### 10. UI border contrast below 3:1 (WCAG 1.4.11)
- Evidence: `--line` against backgrounds is 1.17:1 (light, on bg) and 1.28:1 (light, on surface); 1.78:1 (dark, on bg) and 1.51:1 (dark, on surface). `--line` is used for both card dividers and the borders of the search box and buttons.
- Fix: add `--line-strong` used only for inputs and button outlines. Candidates (already computed): light `128 134 186` gives 3.19:1 on bg and 3.48:1 on surface; dark `110 118 184` gives 4.57:1 on bg and 3.88:1 on surface. Keep `--line` for decorative dividers.
- Accept: borders of search input, filter chips and buttons are at least 3:1 against adjacent colors in both themes.

### 11. Too many brand hues; red used as brand and status
- Evidence: royal, red, purple, sky and gold appear together, plus a red→magenta→purple gradient. The hero headline mixes blue and red; the three shortcut cards use red, purple, sky. Red marks the active menu item and "clear filters", so it cannot clearly mean "error". Form error styling was not inspected.
- Fix: define semantic tokens: primary (royal blue), accent (purple, gradients and highlights only), danger (red, errors only), warning (gold), success (green, new), info (sky or retire it). Recolor the active nav item and "clear filters" to primary.
- Accept: red appears only for error/destructive meaning.

### 12. Light-mode small text barely passes AA
- Evidence: several pairs sit at 4.7–5.0:1 (red on red-soft 4.70, sky on sky-soft 4.83, gold on surface-2 4.92). Thai has thin strokes and small marks.
- Fix: target 5.5–7:1 for text under 14 px. Computed candidates on the light bg / surface: `--ink-2` `74 84 128` (6.71 / 7.31), `--red` text `190 18 36` (5.84 / 6.36), `--sky` `0 98 142` (6.14 / 6.69), `--gold` `122 78 0` (6.60 / 7.20). Check the new red against the brand guide, and recheck the "soft" chip pairs after changing (darker text should only raise contrast, but it was not recomputed).
- Accept: all text under 14 px is at least 5.5:1 in light mode.

### 13. No `theme-color` or `color-scheme` meta
- Evidence: neither tag is present in `<head>`. Theme is applied by JavaScript (`dark` class on `<html>`), so a light flash on load is possible (not tested).
- Fix: add `<meta name="color-scheme" content="light dark">` and two `theme-color` tags with `media="(prefers-color-scheme: …)"`. Set the theme class in an inline script in `<head>` before first paint.
- Accept: no light flash in dark mode on reload; browser UI color matches the theme.

### 14. White text over album cover images
- Evidence: album cards place white text over cover photos. Titles were readable in the cards checked, but sub-lines (e.g. "ข่าว 3") are small and sit over bright areas.
- Fix: add a bottom-up dark gradient scrim covering about 50–60% of the card height behind the text.
- Accept: text on the card has at least 4.5:1 against a white test image used as cover.

## Low priority

15. **Tap targets under 44 px.** Theme buttons in the account menu are 29 px tall (35–72 px wide); calendar date chips are 38 px tall. Raise to at least 44×44 px (or 24×24 with spacing at minimum).
16. **View counts of 0 or 1** appear on many cards and hurt credibility. Hide the counter until it passes a threshold, or remove it.
17. **Duplicate search boxes on the search page** (header and page body). Hide the header one on this page.
18. **Three links use `href="#"`**: "หน้าแรก" and the logo (header and footer). Point them to `/`.
19. **11 px text** in 4 places, plus the tagline under the logo and sub-labels on shortcut cards at desktop width. Raise to at least 12 px.
20. **Logo file is 192 px but shown at 36–48 px.** Ship a smaller variant (e.g. 96 px, or SVG).
21. **Google sign-in button** is a white square-cornered rectangle in a dark rounded UI. Round the corners to match; keep Google's brand rules for the logo and label.
22. **Three images lack `loading="lazy"`.** Add it to below-the-fold images; keep eager loading for the first hero image.
23. **Dark-mode text is very bright.** `--ink` `240 240 255` is 17.21:1 on bg; `232 233 250` keeps 16.15:1 and reduces glare.

## Proposed token changes (verified contrast)

Values are RGB triplets matching the existing token format. Backgrounds used: light bg `245 244 255`, light surface `255 255 255`, dark bg `10 11 32`, dark surface `24 27 66`.

| Token | Theme | Current | Proposed | Contrast on bg / surface |
|---|---|---|---|---|
| `--line-strong` (new) | light | n/a (uses `--line` 224 226 250) | 128 134 186 | 3.19 / 3.48 |
| `--line-strong` (new) | dark | n/a (uses `--line` 50 56 110) | 110 118 184 | 4.57 / 3.88 |
| `--ink-2` | light | 92 102 148 (5.09 / 5.55) | 74 84 128 | 6.71 / 7.31 |
| `--red` (text) | light | 209 19 39 (5.03 / 5.48) | 190 18 36 | 5.84 / 6.36 |
| `--sky` | light | 0 112 161 (5.03 / 5.48) | 0 98 142 | 6.14 / 6.69 |
| `--gold` | light | 148 94 0 (4.99 / 5.44) | 122 78 0 | 6.60 / 7.20 |
| `--ink` | dark | 240 240 255 (17.21 / 14.61) | 232 233 250 | 16.15 / 13.71 |

Current contrast of other tokens, for reference (light / dark, on bg): ink-2 5.09 / 9.99, royal 7.15 / 8.43, red 5.03 / 7.19, purple 5.39 / 8.63, sky 5.03 / 10.41, gold 4.99 / 13.17. White text on the primary gradient stops: 4.95 (#DE142A), 5.95 (#B3218F), 5.88 (#7A3CE2).

Suggested semantic palette (item 11): primary = royal blue, accent = purple, danger = red, warning = gold, success = green (not yet in the system; pick a value and verify contrast in both themes), info = sky or drop it.

## What to keep

- Fast load and light page weight.
- Token-based theming with separate light and dark values; dark mode uses a navy background with layered surfaces, not pure black, and lighter pastel accents.
- Landmarks, skip link, labeled search input, visible focus ring, `prefers-reduced-motion` support.
- Clear no-results state with a recovery path; clear explanation that news before 1 Oct 2569 lives on the faculty sites and the old Facebook page.
- Complete Open Graph tags, share button, "view all photos" and related news on article pages.

## Suggested work batches

1. Navigation and header: items 1, 2, 4, 17, 18.
2. Content and sharing: items 3, 5, 6, 7, 8, 9, 16.
3. Color system: items 10, 11, 12, 13, 14, 23, 21.
4. Polish: items 15, 19, 20, 22.

After each batch, re-run: contrast check in both themes, a scan for images with empty `alt`, and a visual check at 375, 618, 768 and 1440 px.
