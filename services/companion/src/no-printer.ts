/**
 * #827: what the companion says when something needs a printer and none is listed yet. A fresh computer runs with
 * only a placeholder printer config (the Linux host writes one to a file; on a Mac the companion builds it, #834), which
 * the catalog never lists. Projects, settings and the AI rows still answer, and anything that goes through a printer's
 * MCP says so in these words, checked on each call. The setup page's own step is "In Settings › Printers, add your printer."
 */
/** Printing (print, estimate, the printer check, the handoff route, `/v1/mcp`) needs a listed printer. */
export const NO_PRINTER = 'Add a printer in Settings › Printers first.';
/**
 * Design passes, scan touch-ups, STL sizes and the Blender, Fusion and code engine checks run through printer software
 * (a printer MCP), not a printer: the listed printer's, else Counterpart's own copy. These say so only when no printer
 * software is installed at all. Add printer doesn't install it (setup.ts `#entry`: "Download … first, then add the
 * printer."), so they point at Download in Settings › Printers.
 */
export const NO_SOFTWARE_FOR_DESIGN = 'Designs and touch-ups run through your printer software, and none is installed yet. Download it in Settings › Printers first.';
export const noSoftwareToCheck = (tool: string): string =>
  `Counterpart checks ${tool} through your printer software, and none is installed yet. Download it in Settings › Printers, then check again.`;
export const NO_SOFTWARE_FOR_CODE_ENGINE = 'The code design engine comes with your printer software, and none is installed yet. Download it in Settings › Printers to set it up.';
