declare module 'heic-decode' {
  interface DecodedImage {
    width: number;
    height: number;
    /** RGBA, 4 bytes a pixel. */
    data: Uint8ClampedArray;
  }

  /** Decodes the first image in a HEIC or HEIF file. */
  export default function decode(input: { buffer: Uint8Array }): Promise<DecodedImage>;
}
