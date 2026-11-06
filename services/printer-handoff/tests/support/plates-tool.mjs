// A stand-in for the MCPs' list_3mf_plates (bambu-printer-mcp 1.1.69, mcp-3d-printer-server 1.2.49), answered the
// way they read a project's plates. Tests' fake sessions use it; Counterpart itself reads no plate metadata.
import {readFile} from 'node:fs/promises';
import {inspectModelFile, modelPlatePreview} from '../../dist/model-file.js';

export async function platesResult(path, thumbnails = true) {
  const bytes = await readFile(path);
  const info = inspectModelFile(bytes, '3mf');
  const plates = info.plates.map(plate => {
    const png = thumbnails ? modelPlatePreview(bytes, plate.index) : undefined;
    return {index: plate.index, name: plate.name, objects: plate.objects, sliced: plate.sliced, ...(png ? {thumbnail_png_base64: png.toString('base64')} : {})};
  });
  const value = {plate_count: plates.length, plates, ...(info.title ? {title: info.title} : {}), ...(info.designer ? {designer: info.designer} : {})};
  return {content: [{type: 'text', text: JSON.stringify(value)}], structuredContent: value};
}
