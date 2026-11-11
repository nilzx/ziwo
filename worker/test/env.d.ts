declare namespace Cloudflare {
  interface Env {
    MEMORY: DurableObjectNamespace<import("../src/memory-object").Memory>;
    DIRECTORY: DurableObjectNamespace<import("../src/directory").Directory>;
    GUARD: DurableObjectNamespace<import("../src/guard").Guard>;
    OAUTH_KV: KVNamespace;
  }
}

// A file imported as text, as Vite serves it (config.test.ts).
declare module "*?raw" {
  const text: string;
  export default text;
}
