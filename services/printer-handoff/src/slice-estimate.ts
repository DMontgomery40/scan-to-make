import {unzipSync, strFromU8} from 'fflate';

export interface SliceEstimate { seconds?: number; grams?: number }

/** Bambu/Orca store per-plate estimates in the sliced 3MF, not in the model. */
export async function sliceEstimate(bytes: Buffer, plateIndex = 0): Promise<SliceEstimate | undefined> {
  try {
    if (bytes.length > 128 * 1024 * 1024 || plateIndex < 0 || !Number.isInteger(plateIndex)) return undefined;
    const files = unzipSync(bytes, {filter:file => file.name === 'Metadata/slice_info.config' && file.originalSize <= 1024 * 1024});
    const metadata = files['Metadata/slice_info.config'];
    if (!metadata) return undefined;
    const xml = strFromU8(metadata);
    const plates = xml.match(/<plate(?:\s[^>]*)?>[\s\S]*?<\/plate>/g) ?? [];
    const plate = plates.find(p => new RegExp(`<metadata\\s+key=["']index["']\\s+value=["']${plateIndex + 1}["']`).test(p));
    if (!plate) return undefined;
    const value = (key: string) => {
      const text = plate.match(new RegExp(`<metadata\\s+key=["']${key}["']\\s+value=["']([^"']+)["']`))?.[1];
      if (!text || !/^\d+(?:\.\d+)?$/.test(text)) return undefined;
      const number = Number(text);
      return Number.isFinite(number) && number > 0 ? number : undefined;
    };
    const seconds = value('prediction'), grams = value('weight');
    return seconds === undefined && grams === undefined ? undefined : {...(seconds === undefined ? {} : {seconds}), ...(grams === undefined ? {} : {grams})};
  } catch { return undefined; }
}
