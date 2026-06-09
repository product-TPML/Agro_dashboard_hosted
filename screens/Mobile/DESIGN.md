---
name: AgroMetric Design System
colors:
  surface: '#fbf8ff'
  surface-dim: '#d5d8f9'
  surface-bright: '#fbf8ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f4f2ff'
  surface-container: '#ececff'
  surface-container-high: '#e5e6ff'
  surface-container-highest: '#dee0ff'
  on-surface: '#161a32'
  on-surface-variant: '#414844'
  inverse-surface: '#2b2f48'
  inverse-on-surface: '#f0efff'
  outline: '#717973'
  outline-variant: '#c1c8c2'
  surface-tint: '#3f6653'
  primary: '#012d1d'
  on-primary: '#ffffff'
  primary-container: '#1b4332'
  on-primary-container: '#86af99'
  inverse-primary: '#a5d0b9'
  secondary: '#5f5e5b'
  on-secondary: '#ffffff'
  secondary-container: '#e2dfdb'
  on-secondary-container: '#636260'
  tertiary: '#3b1f00'
  on-tertiary: '#ffffff'
  tertiary-container: '#56340e'
  on-tertiary-container: '#cd9d6d'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#c1ecd4'
  primary-fixed-dim: '#a5d0b9'
  on-primary-fixed: '#002114'
  on-primary-fixed-variant: '#274e3d'
  secondary-fixed: '#e5e2de'
  secondary-fixed-dim: '#c8c6c2'
  on-secondary-fixed: '#1c1c19'
  on-secondary-fixed-variant: '#474744'
  tertiary-fixed: '#ffdcbd'
  tertiary-fixed-dim: '#f0bd8b'
  on-tertiary-fixed: '#2c1600'
  on-tertiary-fixed-variant: '#623f18'
  background: '#fbf8ff'
  on-background: '#161a32'
  surface-variant: '#dee0ff'
typography:
  display-report:
    fontFamily: Libre Caslon Text
    fontSize: 36px
    fontWeight: '700'
    lineHeight: '1.2'
  headline-card:
    fontFamily: Libre Caslon Text
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.3'
  price-hero:
    fontFamily: Inter
    fontSize: 22px
    fontWeight: '700'
    lineHeight: '1.1'
    letterSpacing: -0.02em
  price-trend:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '600'
    lineHeight: '1.2'
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.5'
  label-caps:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '700'
    lineHeight: '1.4'
    letterSpacing: 0.05em
  data-subtle:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.4'
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base: 4px
  card-padding: 24px
  gutter: 16px
  section-gap: 32px
  container-max: 1280px
---

## Brand & Style
The design system is engineered for the modern agricultural professional, blending the tradition of the land with the precision of data science. It establishes an atmosphere of **Trustworthy Authority** and **Analytical Clarity**.

The visual style is a **Modern-Corporate** hybrid that utilizes a "Nature-Modern" aesthetic. It moves away from cold, industrial dashboards toward a more organic yet structured interface. It uses high-quality typography to evoke the feel of a premium market report while maintaining the functional density required for complex price tracking. The goal is to provide a sense of calm and control amidst fluctuating market data.

## Colors
This design system uses a grounded, "Nature-Modern" palette to establish reliability.

- **Primary (Forest Green):** Used for primary actions, branding elements, and signifying positive market growth.
- **Secondary (Sand):** A warm, earthy neutral used for card backgrounds and container surfaces to reduce eye strain compared to pure white.
- **Background (Slate/Paper):** A subtle, cool-grey neutral used for the application background to provide contrast against the warm containers.
- **Price Trends:** 
    - **Emerald Green:** Reserved for price increases and upward trends.
    - **Crimson Red:** Reserved for price decreases and downward trends.
    - **Amber Gold:** Specifically for "Modal" price points and cautionary indicators.

## Typography
The typography system relies on a high-contrast pairing between a sophisticated serif and a utilitarian sans-serif.

- **Headlines & Headers:** **Libre Caslon Text** is used for commodity names and report titles. This provides the "Market Report" authority.
- **Data & UI:** **Inter** is used for all prices, labels, and interactive components.
- **Numerical Hierarchy:** Prices must be set in a heavier weight (Bold/700) than their accompanying labels to ensure they are the first thing a user sees.
- **Labels:** Labels use uppercase styling with increased letter-spacing to distinguish them from the data they describe.

## Layout & Spacing
The layout follows a **Fixed Grid** philosophy on desktop to maintain the integrity of data tables and charts, transitioning to a **Fluid Column** system on mobile.

- **Desktop:** 12-column grid with 24px gutters. Cards should typically span 4 columns for price metrics or 12 columns for large historical charts.
- **Metric Grid:** Inside price cards, use a 3-column internal grid for Max, Min, and Modal prices to ensure alignment across different cards.
- **Rhythm:** Use a 4px baseline grid. Padding within cards should be generous (24px or 32px) to move away from the cramped "wireframe" look and provide professional breathing room.
- **Mobile:** Elements stack vertically with 16px side margins.

## Elevation & Depth
Depth is created through **Tonal Layers** and **Subtle Outlines** rather than heavy shadows, maintaining a clean and professional look.

- **Surface Level 0:** The main application background (Slate Grey).
- **Surface Level 1 (Cards):** Light Sand/Off-white containers with a 1px border (#D1D5DB).
- **Elevation:** Use a very soft, high-diffusion shadow (8% opacity, 12px blur) only on the primary active card to denote focus. 
- **Dividers:** Use hairline horizontal rules (1px) in a light earth tone to separate header information from the price grid within cards.

## Shapes
The shape language is **Refined and Rounded**, signifying a modern approach to agriculture.

- **Main Cards:** 1rem (16px) corner radius to soften the data-heavy interface.
- **Buttons & Inputs:** 0.5rem (8px) corner radius for a sturdy, professional feel.
- **Trends & Chips:** Use pill-shaped (full round) containers for price trend badges (e.g., "+100") to make them instantly recognizable as status indicators.

## Components

- **Price Cards:** Should feature the commodity name in Serif at the top, followed by a horizontal divider. Below the divider, a structured grid displays the three core metrics (Max, Min, Modal) with bold prices and small trend arrows.
- **Trend Indicators:** Simple 1.5px line-weight arrows. Up-right arrow for emerald green, down-right arrow for crimson red.
- **Buttons:** Primary buttons use the Forest Green background with white text. Secondary buttons use an outline style with Forest Green borders.
- **Historical Charts:** Use clean line graphs with 2px paths. Avoid area fills unless very low opacity (5%). Use the semantic colors (Emerald, Crimson, Amber) for the specific price lines.
- **Data Lists:** For "Price Updates" and "Arrivals," use a clean vertical list with labels in subtle caps and values in bold Inter.
- **Tooltips:** Use the "Sand" color for tooltip backgrounds with a small drop shadow to distinguish from the primary card surface.