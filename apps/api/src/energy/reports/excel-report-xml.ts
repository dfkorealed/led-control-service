import JSZip from "jszip";

/** XML parsers normalize literal CR/CRLF. Character references preserve the exact
 * scalar string without changing document content or Excel's native numeric cells.
 */
export async function preserveXmlCarriageReturns(bytes: Buffer): Promise<Buffer> {
  const archive = await JSZip.loadAsync(bytes);
  let changed = false;
  for (const entry of Object.values(archive.files)) {
    if (entry.dir || !entry.name.endsWith(".xml")) continue;
    const xml = await entry.async("string");
    if (!xml.includes("\r")) continue;
    archive.file(entry.name, xml.replace(/\r/g, "&#13;"));
    changed = true;
  }
  return changed ? archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) : bytes;
}
