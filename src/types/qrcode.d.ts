/**
 * Minimal ambient types for `qrcode` (the package ships none and we don't
 * want a new @types dev-dep just for two call sites). Covers only what this
 * codebase uses — extend if more of the API is needed.
 */
declare module "qrcode" {
  interface QRCodeToDataURLOptions {
    width?: number;
    margin?: number;
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  }
  interface QRCodeToStringOptions {
    type?: "terminal" | "svg" | "utf8";
    small?: boolean;
    margin?: number;
  }
  const QRCode: {
    toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
    toString(text: string, options?: QRCodeToStringOptions): Promise<string>;
    toFile(path: string, text: string, options?: QRCodeToDataURLOptions): Promise<void>;
  };
  export default QRCode;
}
