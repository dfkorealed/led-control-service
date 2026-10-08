import { Directory, File, Paths } from 'expo-file-system';
import { isAvailableAsync, shareAsync } from 'expo-sharing';
import { assertPrivateFileName, type TemporaryFile } from './file-transfer';

const directoryName = 'led-control-shares';
let sequence = 0;

export function cleanAbandonedShares(): void {
  const directory = new Directory(Paths.cache, directoryName);
  if (directory.exists) directory.delete();
}

export function createPrivateFile(name: string): TemporaryFile {
  assertPrivateFileName(name);
  const root = new Directory(Paths.cache, directoryName);
  root.create({ idempotent: true, intermediates: true });
  // A unique per-transfer directory avoids collisions; user names never become a parent path.
  const directory = new Directory(root, `${Date.now()}-${++sequence}`);
  directory.create();
  const file = new File(directory, name);
  let handle: ReturnType<File['open']> | undefined;
  try { file.create(); handle = file.open(); }
  catch (error) { directory.delete(); throw error; }
  return {
    uri: file.uri,
    append(bytes) { if (!handle) throw new Error('closed-file'); handle.writeBytes(bytes); },
    size() { return file.size; },
    close() { if (handle) { handle.close(); handle = undefined; } },
    remove() { if (directory.exists) directory.delete(); }
  };
}

export async function sharePrivateFile(file: TemporaryFile, mime: string): Promise<void> {
  if (!await isAvailableAsync()) throw new Error('sharing-unavailable');
  await shareAsync(file.uri, { mimeType: mime, UTI: mime === 'application/pdf' ? 'com.adobe.pdf' : 'public.comma-separated-values-text', dialogTitle: '파일 저장·공유' });
}
