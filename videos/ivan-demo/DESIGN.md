# I-VAN Install Demo — Visual Identity

## Style Prompt

Premium automotive safety instructional — clean, confident, modern. Navy-blue canvas with high-contrast white type and a single energetic orange accent for step markers. Motion is precise and mechanical: elements snap into place like ISOFIX clicks, connectors extend with deliberate easing, checks confirm with satisfying pops. Think Apple product demo meets safety compliance briefing. No cartoonishness — this is a product people trust with their child.

## Colors

- `#0B1F3A` — Primary canvas (deep automotive navy)
- `#FFFFFF` — Primary text
- `#FF6B35` — Accent (step markers, active connectors, warnings) — safety-signal orange
- `#00D68F` — Success (verified indicators, green checkmarks)
- `#AEC0D9` — Secondary text / muted elements
- `#1A3459` — Card surfaces / slightly lifted navy

## Typography

- Headlines: `Rubik` (900 / 700) — strong Hebrew + Latin support, geometric, reads instantly
- Body/Labels: `Heebo` (500 / 400) — clean Hebrew workhorse, pairs with Rubik
- Numerals: tabular for step numbers (01, 02, 03, 04)

## Motion Signature

- Entrance easing: `expo.out` for hero elements, `power3.out` for supporting
- Exit: handled by scene transitions only (no per-element fades)
- ISOFIX click / Top Tether extend: `back.out(1.4)` for mechanical satisfaction
- Checkmark pop: `back.out(2)` scale from 0
- Step number counter: always animates from previous scene (01 → 02 → 03 → 04)

## What NOT to Do

1. No drop shadows on body text (looks cheap on navy)
2. No gradient backgrounds on full-screen panels (H.264 banding)
3. No cartoon icons or playful color palette — this is safety equipment, not toys
4. No decorative motion (orbiting particles, floating shapes) — every motion must serve the instruction
5. No English-only copy — Hebrew first (RTL), Latin only for product name "I-VAN", "ISOFIX", "Top Tether", "Kikkaboo"

## Layout

- 1920×1080 landscape
- RTL flow for Hebrew content, Latin terms stay LTR inline
- Step number always top-right in RTL layout (where eye enters)
- Consistent padding: 120px horizontal, 96px vertical
