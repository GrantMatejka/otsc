import { getFormDataStream } from "./form-data.utils.js";
import { OtscError } from "../otsc-error.js";
import type { OtscPlugin } from "../otsc.types.js";

const plugin: OtscPlugin = {
  name: "form-data",
  request: async (_, config) => {
    if (typeof config.data !== "object" || Array.isArray(config.data)) {
      throw new OtscError(
        "Otsc: multipart/form-data body must be an object",
        config
      );
    }
    const result = getFormDataStream(config.data as any);
    return {
      ...config,
      data: result.data,
      headers: {
        ...config.headers,
        ...result.headers,
      },
    };
  },
};

/**
 * form-data plugin used internally by Otsc.
 * @example
 * ```typescript
 *   const apiClient = new Otsc(
 *     "https://mywebsite.com",
 *     [{
 *       method: "post",
 *       path: "/upload",
 *       alias: "upload",
 *       description: "Upload a file",
 *       requestFormat: "form-data",
 *       parameters:[
 *         {
 *           name: "body",
 *           type: "Body",
 *           schema: z.object({
 *             file: z.instanceof(File),
 *           }),
 *         }
 *       ],
 *       response: z.object({
 *         id: z.number(),
 *       }),
 *     }],
 *   );
 *   const id = await apiClient.upload({ file: document.querySelector('#file').files[0] });
 * ```
 * @returns form-data plugin
 */
export function formDataPlugin(): OtscPlugin {
  return plugin;
}
