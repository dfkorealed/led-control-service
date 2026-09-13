export interface BioByteConnection {
  open(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  onData(listener: (bytes: Buffer) => void): () => void;
  onDisconnect(listener: (error: Error) => void): () => void;
}
