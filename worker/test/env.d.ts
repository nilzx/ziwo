declare namespace Cloudflare {
  interface Env {
    MEMORY: DurableObjectNamespace<import("../src/memory-object").Memory>;
  }
}
