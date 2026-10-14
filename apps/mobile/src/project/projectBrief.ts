/** A local planning draft, independent of any template's measurement contract. */
export interface ProjectBrief {
  object: string;
  context: string;
  addition: string;
}
export const emptyBrief = (): ProjectBrief => ({
  object: '',
  context: '',
  addition: '',
});
export const briefComplete = (brief: ProjectBrief) =>
  Object.values(brief).every(value => value.trim().length > 0);
export const shareableBrief = (brief: ProjectBrief) =>
  `Scan to Make — project brief\n\nObject\n${brief.object.trim()}\n\nSurroundings & constraints\n${brief.context.trim()}\n\nWhat I want to add\n${brief.addition.trim()}\n\nPlanning brief only; no scan, generated geometry or fit verification.`;
