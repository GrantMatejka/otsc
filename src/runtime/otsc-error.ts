import { ReadonlyDeep } from "./utils.types.js";
import { AnyOtscRequestOptions } from "./otsc.types.js";

/**
 * Custom Otsc Error with additional information
 * @param message - the error message
 * @param data - the parameter or response object that caused the error
 * @param config - the config object from otsc
 * @param cause - the error cause
 */
export class OtscError extends Error {
  constructor(
    message: string,
    public readonly config?: ReadonlyDeep<AnyOtscRequestOptions>,
    public readonly data?: unknown,
    public readonly cause?: Error
  ) {
    super(message);
  }
}
