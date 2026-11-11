import { Memory } from "./memory-object";

export { Memory };

export interface Env {
  MEMORY: DurableObjectNamespace<Memory>;
}

// The Worker in front of the memories. Stage P1b routes requests to them.
export default {
  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
