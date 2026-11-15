/**
 * #827: what the companion says when something needs a printer and none is set up yet. A fresh Mac (or Linux computer)
 * has no printer handoff config: projects, settings and the AI rows still answer, and anything that goes through a
 * printer's MCP says so in these words. The setup page's own step is "In Settings › Printers, add your printer."
 */
export const NO_PRINTER = 'Add a printer in Settings › Printers first.';
/** Design passes, scan touch-ups and the Blender, Fusion and code engine checks all run through a printer's MCP. */
export const NO_PRINTER_FOR_DESIGN = 'Designs and touch-ups run through your printer software. Add a printer in Settings › Printers first.';
export const noPrinterToCheck = (tool: string): string =>
  `Counterpart checks ${tool} through your printer software. Add a printer in Settings › Printers, then check again.`;
export const NO_PRINTER_FOR_CODE_ENGINE = 'The code design engine comes with your printer software. Add a printer in Settings › Printers to set it up.';
