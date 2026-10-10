---
name: Viral Studio Radar
colors:
  surface: '#111319'
  surface-dim: '#111319'
  surface-bright: '#373940'
  surface-container-lowest: '#0c0e14'
  surface-container-low: '#191b22'
  surface-container: '#1e1f26'
  surface-container-high: '#282a30'
  surface-container-highest: '#33343b'
  on-surface: '#e2e2eb'
  on-surface-variant: '#c2c6d6'
  inverse-surface: '#e2e2eb'
  inverse-on-surface: '#2e3037'
  outline: '#8c909f'
  outline-variant: '#424754'
  surface-tint: '#adc6ff'
  primary: '#adc6ff'
  on-primary: '#002e6a'
  primary-container: '#4d8eff'
  on-primary-container: '#00285d'
  inverse-primary: '#005ac2'
  secondary: '#ffb3af'
  on-secondary: '#68000d'
  secondary-container: '#970017'
  on-secondary-container: '#ff9e99'
  tertiary: '#4edea3'
  on-tertiary: '#003824'
  tertiary-container: '#00a572'
  on-tertiary-container: '#00311f'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#d8e2ff'
  primary-fixed-dim: '#adc6ff'
  on-primary-fixed: '#001a42'
  on-primary-fixed-variant: '#004395'
  secondary-fixed: '#ffdad7'
  secondary-fixed-dim: '#ffb3af'
  on-secondary-fixed: '#410005'
  on-secondary-fixed-variant: '#930016'
  tertiary-fixed: '#6ffbbe'
  tertiary-fixed-dim: '#4edea3'
  on-tertiary-fixed: '#002113'
  on-tertiary-fixed-variant: '#005236'
  background: '#111319'
  on-background: '#e2e2eb'
  surface-variant: '#33343b'
typography:
  headline-xl:
    fontFamily: Plus Jakarta Sans
    fontSize: 40px
    fontWeight: '800'
    lineHeight: 48px
    letterSpacing: -0.02em
  headline-xl-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 30px
    fontWeight: '800'
    lineHeight: 36px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.015em
  headline-lg-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.005em
  body-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 18px
  label-lg:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: 0.01em
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.02em
  label-sm:
    fontFamily: Inter
    fontSize: 10px
    fontWeight: '700'
    lineHeight: 14px
    letterSpacing: 0.04em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-mobile: 0.75rem
  margin: 1.5rem
  margin-mobile: 1rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2rem
---

## Brand & Style

This design system targets independent tech, AI, and developer-creators across India producing rapid vertical content for YouTube Shorts and Instagram Reels. The emotional core balances operational calm with instant kinetic validation: creators often work under tight posting schedules and algorithm anxiety, so the environment must act as a disciplined, distraction-free cockpit that amplifies confidence rather than stress. 

The aesthetic style is **Focused Technical Modernism with Kinetic Accents**. It relies on deep, obsidian charcoal foundations punctuated by precise electric blue focal paths and an intentional, scarce flash of hot coral reserved exclusively for breakout viral triggers. Interfaces are tactile and swift, adopting mobile-native ergonomics suited for one-handed thumb navigation. The editorial tone couples crisp product utility with natural tech-corridor Hinglish idioms—grounding high-leverage workflows in relatable, energetic colloquialisms.

## Colors

The palette operates in strict dark mode by default, built around a three-tier depth architecture using cool charcoal foundations:
- **Base Canvas (`#0F1117`)**: Background floor for screen templates, providing infinite contrast for overlays.
- **Surface Elevation 1 (`#1A1D27`)**: Container cards, feeds, toolbars, and sheets.
- **Surface Elevation 2 (`#242938`)**: Elevated pills, active card states, inputs, and selected states.

### Accent Roles
- **Electric Blue (`#3B82F6` / `#2563EB`)**: Primary system accent for global interactive paths, tabs, primary CTAs, AI prompts, and primary indicators.
- **Hot Coral (`#FF5757` / `#FF6B6B`)**: Hyper-restricted urgency accent. Used only for breakout spikes ("Aaj ka Viral Radar"), breakout velocity indicators, and recording triggers.
- **Functional States**:
  - Live / Positive Momentum: Emerald Green (`#10B981`).
  - Error / Drop-off / Not Reachable: Pure Red (`#EF4444`).
  - Warning / Unverified / Analyzing: Amber (`#F59E0B`).
  - Dormant / Not Checked / Muted: Slate Grey (`#64748B`).

## Typography

The type scale marries the dynamic, high-tech geometric confidence of Plus Jakarta Sans for titles and body with the surgical precision of Inter for data tables, metrics, script timestamps, and telemetry tags.

Titles set a distinct pacing through tight tracking (`-0.02em`), emphasizing compact, scannable phrases like *"Script pakka hai"* and *"Bawaal tool"*. Data badges, view counters, retention drop-off percentages, and short-form video timers lean on Inter at bold weights (`label-sm`, `label-md`) to guarantee optical legibility over noisy video thumbnails or dense analytics stacks.

## Layout & Spacing

The layout is optimized mobile-first around an archetype viewport width of 390px, ensuring ergonomic, one-thumb reach across the lower 60% of the screen.

### Grid & Canvas Adaptation
- **Mobile (<640px)**: 4-column fluid layout with `1rem` outer canvas padding and `0.75rem` internal gutters. Navigation is strictly anchored to a floating bottom bar or drag-to-dismiss bottom sheet.
- **Tablet (640px–1024px)**: 8-column layout with `1.5rem` margins and `1rem` gutters. Splits feeds into two columns: Script/Prompt Studio on the left, Real-time Trend Radar on the right.
- **Desktop (>1024px)**: 12-column layout capped at a maximum container width of `1200px` centered within `#0F1117`, preserving the clean, uncluttered tool feeling without stretching video cards.

Vertical rhythm adheres strictly to an 8px baseline framework (`0.5rem`, `1rem`, `1.5rem`, `2rem`), with `0.25rem` micro-steps for tightly grouped telemetry stats and status chips.

## Elevation & Depth

Visual hierarchy does not rely on heavy drop shadows, which can muddy dark UI interfaces. Instead, the design system implements **Tonal Layering with Ghost Surface Rings**:

1. **Surface 0 (Base)**: `#0F1117` — Flat floor.
2. **Surface 1 (Cards & Feed Panels)**: `#1A1D27` with a subtle 1px border of `rgba(255, 255, 255, 0.06)`.
3. **Surface 2 (Action Sheets, Floating Bars, Modals)**: `#242938` with a 1px border of `rgba(255, 255, 255, 0.10)` paired with an ambient diffuse shadow (`0px 12px 32px rgba(0, 0, 0, 0.45)`).
4. **Viral Accent Glow**: Reserved for breakout alert surfaces and hot viral spikes. Uses an inner tint overlay plus an external diffuse halo: `0px 0px 24px rgba(255, 87, 87, 0.20)`.
5. **Backdrop Blurs**: Overlays, bottom sheets, and sticky header bars use `backdrop-filter: blur(16px)` over `rgba(15, 17, 23, 0.85)` to retain spatial awareness of underlying metrics.

## Shapes

The design system standardizes on a roundedness level of `2`. Primary content containers, video preview cards, script prompt windows, and bottom sheets adopt a structured `16px` (`1rem`) corner radius. This gives the interface a friendly, app-like finish without feeling juvenile or bubble-like.

Interactive controls and status indicators scale proportionally:
- Segmented pills, filter tags, and viral badge indicators utilize full capsule curves (`9999px`).
- Form elements, inputs, and inline action buttons maintain `10px` to `12px` radii to preserve their structural identity within `16px` parent cards.

## Components

### Buttons & Interactive Touch Targets
- **Dimensions**: All interactive components enforce a hard minimum tap target of `44px × 44px` for fluid mobile operation.
- **Primary Action**: Electric Blue (`#3B82F6`) background, white text (`Inter SemiBold`), hover/press state shifts to `#2563EB`. Active tap scales down to `0.98` with haptic feedback.
- **Viral Trigger Action**: Hot Coral (`#FF5757`) background, white text, reserved for "Record Now", "Spin AI Script", or "Post Trend".
- **Ghost/Tertiary**: Transparent fill with `1px` border of `rgba(255, 255, 255, 0.12)`, text `#94A3B8`.

### Chips & Status Indicators
- Status chips sit at `24px` height with `label-sm` typography and `8px` horizontal padding:
  - **Live**: Emerald pill background `rgba(16, 185, 129, 0.15)` with text `#10B981` and a `6px` pulsing green dot.
  - **Viral**: Hot Coral pill background `rgba(255, 87, 87, 0.15)` with text `#FF5757` paired with a miniature flame icon.
  - **Unverified**: Amber pill `rgba(245, 158, 11, 0.15)` with text `#F59E0B`.
  - **Not Checked**: Slate pill `rgba(100, 116, 139, 0.15)` with text `#94A3B8`.

### Cards
- Set on `#1A1D27` with `16px` radius and `1rem` internal padding. 
- Multi-metric cards display the trend rank or video hook at the top, a 9:16 compact thumbnail preview, and engagement velocity meters at the base.
- Active or focused cards brighten their outline to `rgba(59, 130, 246, 0.50)`.

### Input Fields & Prompt Editors
- Background `#242938`, text color `#F8FAFC`, placeholder `#64748B`.
- 1px border initialized at `rgba(255, 255, 255, 0.08)`. Transitions to `#3B82F6` upon focus with zero horizontal layout shift.
- Height is fixed at `48px` for single-line inputs; script areas feature auto-expanding textareas with floating character/token count pills in the bottom right corner.

### Mobile Bottom Sheets & Toasts
- **Bottom Sheets**: Pull-up sheets feature a centered top grab handle (`36px × 4px`, color `rgba(255, 255, 255, 0.20)`), `20px` top corner radii, and a high-blur dark backdrop (`#0F1117` at 70% opacity).
- **Toast Notifications**: Floating snackbars pinned `24px` above the bottom safe area with Hinglish confirmation prompts (e.g., *"Script pakka hai! Saved to drafts."*), styled with a `#242938` background, glowing 1px border, and leading status glyph.