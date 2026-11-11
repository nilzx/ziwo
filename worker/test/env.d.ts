declare namespace Cloudflare {
  interface Env {
    MEMORY: DurableObjectNamespace<import("../src/memory-object").Memory>;
    DIRECTORY: DurableObjectNamespace<import("../src/directory").Directory>;
  }
}
