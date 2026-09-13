/**
 * [확인됨] transport가 사용하는 최소 byte-stream 소유권 경계다. direct USB 구현은
 * 최대 32-byte bulk read를 전달하지만 한 callback이 한 BIO frame이라는 보장은 없다.
 * [추정] framing/요청 소유권은 이 계층이 아니라 BioFrameCodec/BioUsbTransport가 맡는다.
 */
export interface BioByteConnection {
  open(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  onData(listener: (bytes: Buffer) => void): () => void;
  onDisconnect(listener: (error: Error) => void): () => void;
}
