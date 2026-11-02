import type { OtscPlugin } from "../otsc.types.js";

export function headerPlugin(key: string, value: string): OtscPlugin {
  return {
    request: async (_, config) => {
      return {
        ...config,
        headers: {
          ...config.headers,
          [key]: value,
        },
      };
    },
  };
}
