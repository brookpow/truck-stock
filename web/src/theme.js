// Field-Modern design tokens — shared across all four CCP apps. A sharper, more
// modern sibling to the CRM/GP Apple look: characterful display type, real depth,
// a deeper brand blue. Fonts are self-hosted (see main.jsx + index.css).
export const C = {
  bg: "#F4F5F7", surface: "#FFFFFF", sunk: "#F4F5F7",
  ink: "#14151A", ink2: "#43464F", ink3: "#71757F", hair: "#E6E8EC",
  blue: "#0B63F6", blueInk: "#084BC0", blueWash: "#EAF1FE",
  green: "#18A957", greenInk: "#0E7A3D", greenWash: "#E4F6EC",
  red: "#F5333F", redInk: "#C01722", redWash: "#FDE7E8",
  amber: "#F59E0B", amberInk: "#97600A", amberWash: "#FEF1DA",
  purple: "#6D4AFF", purpleInk: "#4B2ED6", purpleWash: "#ECE7FF",
};
export const FONT = "'Hanken Grotesk Variable', -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
export const DISP = "'Bricolage Grotesque Variable', 'Hanken Grotesk Variable', sans-serif";
export const SHADOW = {
  e1: "0 1px 2px rgba(20,21,26,.04), 0 4px 16px -8px rgba(20,21,26,.10)",
  e2: "0 2px 4px rgba(20,21,26,.05), 0 22px 48px -16px rgba(20,21,26,.24)",
};
// Tinted status pills (bg/fg) — Apple-style badge treatment, Field-Modern hues.
export const BADGE = {
  green: { bg: C.greenWash, fg: C.greenInk }, blue: { bg: C.blueWash, fg: C.blueInk },
  amber: { bg: C.amberWash, fg: C.amberInk }, red: { bg: C.redWash, fg: C.redInk },
  purple: { bg: C.purpleWash, fg: C.purpleInk }, gray: { bg: C.sunk, fg: C.ink2 },
};
